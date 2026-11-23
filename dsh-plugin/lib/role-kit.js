/**
 * Shared body of a Novel Studio role row.
 *
 * Why rows instead of one big plugin: which tools an agent sees is decided by
 * its *scope*, not by its prompt. A preset mounts its own plugin rows, and a
 * row that calls `ctx.tools.register()` registers **scoped** tools — visible to
 * agents composed from that preset and to nobody else. That is how the settings
 * role is kept from ever holding a prose-writing tool: it simply never gets one.
 *
 * Each role therefore exports a tiny plugin whose only job is: take the tool set
 * the top-level plugin published as the `novelRoles` service, register the slice
 * this role may use, and install one `complete` prompt section that renders from
 * the live snapshot.
 *
 * `complete: true` replaces the whole assembled prompt. That is deliberate and
 * matches the original product: a novel-writing agent should not be greeted with
 * the coding-harness identity, and the two role prompts were written as whole
 * system prompts, not as appendices. Contexts still assemble normally, so
 * anything the harness insists on (working directory and friends) survives.
 */

import { adaptContextFor, adaptSystemPrompt } from './adapt.js';
import { adaptCursorChapterId } from './model.js';
import { contextDigest, materialSystemPrompt, writingSystemPrompt } from './prompts.js';

/** Name of the Host service the top-level plugin publishes. */
export const ROLE_SERVICE = 'novelRoles';

/**
 * Roles a preset can mount. `prompt` is called on every assembly, so the live
 * snapshot is re-read per request without re-registering anything.
 */
export const ROLES = {
  material: {
    card: '设定官',
    tools: ['shared', 'material'],
    prompt(service, subjects) {
      const snapshot = service.snapshot();
      const project = snapshot.project;
      if (!project) return NO_PROJECT;
      return [
        materialSystemPrompt(project, { hasAskTool: subjects.hasAskTool }),
        contextDigest(project, { scope: 'material' }),
      ].join('\n\n');
    },
  },
  writing: {
    card: '执笔者',
    tools: ['shared', 'writing'],
    prompt(service, subjects) {
      const snapshot = service.snapshot();
      const project = snapshot.project;
      if (!project) return NO_PROJECT;
      const chapter = snapshot.chapterOutline;
      if (!chapter) return NO_CHAPTER;
      const existing = snapshot.chapter;
      return [
        writingSystemPrompt(project, {
          chapter,
          materials: chapter.materialIds
            .map((id) => project.materials.find((material) => material.id === id))
            .filter(Boolean),
          previous: snapshot.previous,
          previousOutline: snapshot.previousOutline,
          existing,
          mode: existing && existing.content.trim() ? 'rewrite' : 'create',
          interactive: true,
          hasAskTool: subjects.hasAskTool,
        }),
        contextDigest(project, { scope: 'writing', chapterId: chapter.id }),
      ].join('\n\n');
    },
  },
  // The adapter is the one role whose prompt cannot be assembled from the
  // skeleton: it must carry the chapter's original text. That context is
  // stamped into `live.js`'s adaptation cache by the Host half, and this
  // provider only reads it — `systemPrompt.section()` has no room to await.
  adapt: {
    card: '改编者',
    tools: ['adapt'],
    prompt(service) {
      const cached = service.adapt();
      if (!cached) return NO_ADAPT;
      return [
        adaptSystemPrompt(cached.project, cached.ctx),
        contextDigest(cached.project, { scope: 'adapt', chapterId: cached.ctx.chapter.id }),
      ].join('\n\n');
    },
  },
};

const NO_PROJECT =
  '作者目前没有打开任何作品。让他在「小说工坊」里新建或打开一部作品，再回来交代活计。'
  + '在他打开作品之前不要猜测作品内容，也不要用工具去翻别的工程。';

const NO_CHAPTER =
  '作者打开了一部作品，但没有选中章节。让他在左侧章节列表里点开要写的那一章，'
  + '或者先和你商定章节再动手。不要自己新建章节来绕过这个选择。';

const NO_ADAPT =
  '现在没有可以改编的章节。改编要作者先打开一部改编工程，并在左侧点开要改的那一章 —— '
  + '这一章的原书文字必须能被读到，才谈得上改编。在他准备好之前不要凭记忆改写任何一章，'
  + '也不要用工具去翻别的工程。';

/**
 * Build the plugin a role row mounts.
 *
 * @param {'material'|'writing'|'adapt'} id
 * @returns {{ name: string, inject: string[], apply: (ctx: unknown) => void }}
 */
export function defineRole(id) {
  const role = ROLES[id];
  return {
    name: `novel-studio/${id}`,
    inject: ['tools', 'systemPrompt', ROLE_SERVICE],
    apply(ctx) {
      const service = ctx.get(ROLE_SERVICE);
      // A role row without the service is a wiring bug, not a user problem:
      // say so once and register nothing rather than half-registering a role
      // that would then answer with tools it cannot back.
      if (!service) {
        ctx.logger?.warn?.(`novel-studio: role "${id}" found no ${ROLE_SERVICE} service; no tools registered`);
        return;
      }
      // Read live, not at apply time: the ask tool may arrive after this row.
      const subjects = {
        get hasAskTool() {
          return ctx.get('userQuestions') !== undefined;
        },
      };

      for (const group of role.tools) {
        for (const definition of service.tools[group]) {
          ctx.effect(() => ctx.tools.register(definition), `novel-studio: ${id}/${definition.name}`);
        }
      }

      ctx.effect(
        () => ctx.systemPrompt.section({
          name: `novel-studio:${id}`,
          // 0 = DEPLOYMENT_PERSONA_PREFIX: the role prompt stands where the
          // deployment persona would, because it replaces the whole prompt.
          order: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
          text: () => role.prompt(service, subjects),
          complete: true,
        }),
        `novel-studio: ${id} prompt`
      );
    },
  };
}

/** The preset row that mounts a role, for `agentPresets.register`. */
export function roleRow(id) {
  return { id: `novel-${id}`, name: `@local/dsh-novel-studio/role/${id}`, config: {} };
}