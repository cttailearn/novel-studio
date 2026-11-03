//! SQLite 持久层。
//!
//! 前端把 IndexedDB 的「object store + key + JSON value」原样映射到这里；
//! Rust 只负责事务落盘，不解析业务结构。这样 `project-idb.ts` 与
//! `idb-stores.ts` 的业务代码一行都不用改，换的只是底层 IDB 工厂。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

pub struct SqliteStore {
    path: PathBuf,
    conn: Mutex<Connection>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlRow {
    pub store: String,
    pub key: String,
    pub value: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreSpec {
    pub name: String,
    pub key_path: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSpec {
    pub store: String,
    pub name: String,
    pub key_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlOp {
    pub store: String,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub clear: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlStats {
    pub rows: i64,
    pub bytes: i64,
    pub path: String,
}

impl SqliteStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("创建数据目录失败：{error}"))?;
        }
        let conn = Connection::open(path).map_err(|error| format!("打开数据库失败：{error}"))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA busy_timeout = 5000;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS objects (
                 db TEXT NOT NULL,
                 store TEXT NOT NULL,
                 key TEXT NOT NULL,
                 value TEXT NOT NULL,
                 PRIMARY KEY (db, store, key)
             );
             CREATE TABLE IF NOT EXISTS stores (
                 db TEXT NOT NULL,
                 name TEXT NOT NULL,
                 key_path TEXT NOT NULL,
                 PRIMARY KEY (db, name)
             );
             CREATE TABLE IF NOT EXISTS indexes (
                 db TEXT NOT NULL,
                 store TEXT NOT NULL,
                 name TEXT NOT NULL,
                 key_path TEXT NOT NULL,
                 PRIMARY KEY (db, store, name)
             );",
        )
        .map_err(|error| format!("初始化数据库失败：{error}"))?;
        Ok(Self {
            path: path.to_path_buf(),
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
        self.conn
            .lock()
            .map_err(|_| "数据库锁已损坏，请重启应用".to_string())
    }
}

#[tauri::command]
pub fn sqlite_path(state: tauri::State<'_, SqliteStore>) -> Result<String, String> {
    Ok(state.path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn sqlite_load(
    state: tauri::State<'_, SqliteStore>,
    db: String,
) -> Result<Vec<SqlRow>, String> {
    let conn = state.lock()?;
    let mut statement = conn
        .prepare("SELECT store, key, value FROM objects WHERE db = ?1 ORDER BY store, key")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![db], |row| {
            Ok(SqlRow {
                store: row.get(0)?,
                key: row.get(1)?,
                value: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn sqlite_stores(
    state: tauri::State<'_, SqliteStore>,
    db: String,
) -> Result<Vec<StoreSpec>, String> {
    let conn = state.lock()?;
    let mut statement = conn
        .prepare("SELECT name, key_path FROM stores WHERE db = ?1 ORDER BY name")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![db], |row| {
            Ok(StoreSpec {
                name: row.get(0)?,
                key_path: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn sqlite_indexes(
    state: tauri::State<'_, SqliteStore>,
    db: String,
) -> Result<Vec<IndexSpec>, String> {
    let conn = state.lock()?;
    let mut statement = conn
        .prepare("SELECT store, name, key_path FROM indexes WHERE db = ?1 ORDER BY store, name")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![db], |row| {
            Ok(IndexSpec {
                store: row.get(0)?,
                name: row.get(1)?,
                key_path: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub fn sqlite_create_index(
    state: tauri::State<'_, SqliteStore>,
    db: String,
    store: String,
    name: String,
    key_path: String,
) -> Result<(), String> {
    let conn = state.lock()?;
    conn.execute(
        "INSERT INTO indexes (db, store, name, key_path) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(db, store, name) DO UPDATE SET key_path = excluded.key_path",
        params![db, store, name, key_path],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_create_store(
    state: tauri::State<'_, SqliteStore>,
    db: String,
    name: String,
    key_path: String,
) -> Result<(), String> {
    let conn = state.lock()?;
    conn.execute(
        "INSERT INTO stores (db, name, key_path) VALUES (?1, ?2, ?3)
         ON CONFLICT(db, name) DO UPDATE SET key_path = excluded.key_path",
        params![db, name, key_path],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_apply(
    state: tauri::State<'_, SqliteStore>,
    db: String,
    ops: Vec<SqlOp>,
) -> Result<(), String> {
    let mut conn = state.lock()?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    for op in ops {
        if op.clear {
            tx.execute(
                "DELETE FROM objects WHERE db = ?1 AND store = ?2",
                params![db, op.store],
            )
            .map_err(|error| error.to_string())?;
            continue;
        }
        match (op.key, op.value) {
            (Some(key), Some(value)) => {
                tx.execute(
                    "INSERT INTO objects (db, store, key, value) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(db, store, key) DO UPDATE SET value = excluded.value",
                    params![db, op.store, key, value],
                )
                .map_err(|error| error.to_string())?;
            }
            (Some(key), None) => {
                tx.execute(
                    "DELETE FROM objects WHERE db = ?1 AND store = ?2 AND key = ?3",
                    params![db, op.store, key],
                )
                .map_err(|error| error.to_string())?;
            }
            (None, _) => {
                return Err("SQLite 操作缺少 key".to_string());
            }
        }
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_import(
    state: tauri::State<'_, SqliteStore>,
    db: String,
    stores: Vec<StoreSpec>,
    rows: Vec<SqlRow>,
) -> Result<(), String> {
    let mut conn = state.lock()?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    for store in stores {
        tx.execute(
            "INSERT INTO stores (db, name, key_path) VALUES (?1, ?2, ?3)
             ON CONFLICT(db, name) DO UPDATE SET key_path = excluded.key_path",
            params![db, store.name, store.key_path],
        )
        .map_err(|error| error.to_string())?;
    }
    for row in rows {
        tx.execute(
            "INSERT INTO objects (db, store, key, value) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(db, store, key) DO UPDATE SET value = excluded.value",
            params![db, row.store, row.key, row.value],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_wipe(state: tauri::State<'_, SqliteStore>, db: String) -> Result<(), String> {
    let mut conn = state.lock()?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM objects WHERE db = ?1", params![db])
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM stores WHERE db = ?1", params![db])
        .map_err(|error| error.to_string())?;
    tx.execute("DELETE FROM indexes WHERE db = ?1", params![db])
        .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn sqlite_stats(state: tauri::State<'_, SqliteStore>) -> Result<SqlStats, String> {
    let conn = state.lock()?;
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM objects", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let bytes: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(LENGTH(value)), 0) FROM objects",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(SqlStats {
        rows,
        bytes,
        path: state.path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn sqlite_backup(state: tauri::State<'_, SqliteStore>, path: String) -> Result<String, String> {
    let target = PathBuf::from(path);
    if target.exists() {
        return Err("备份目标已存在，请换一个文件名".to_string());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let conn = state.lock()?;
    conn.execute("VACUUM INTO ?1", params![target.to_string_lossy()])
        .map_err(|error| format!("备份失败：{error}"))?;
    Ok(target.to_string_lossy().to_string())
}
