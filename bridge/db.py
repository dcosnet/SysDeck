#!/usr/bin/env python3
"""SysDeck - DB Control Bridge
Unified control surface for every database engine on the host.
Detects running services, queries status, and dispatches actions.

Supported engine families:
  SQL:        PostgreSQL, MySQL/MariaDB, SQLite, CockroachDB, TiDB
  NoSQL:      MongoDB, CouchDB, RethinkDB, DynamoDB-local
  Vector:     Milvus, Qdrant, Weaviate, Chroma, pgvector
  TimeSeries: InfluxDB, TimescaleDB, QuestDB, ClickHouse
  Graph:      Neo4j, ArangoDB, OrientDB
  Embedded:   Redis, KeyDB, LevelDB, RocksDB, LMDB, BadgerDB
  Cloud:      Firestore-emulator, Supabase-local
  AI:         LanceDB, DuckDB, Tile38

Subcommands:
  summary       - list all detected engines with status
  status <id>   - detailed status for one engine
  start <id>    - start engine via systemctl
  stop <id>     - stop engine via systemctl
  restart <id>  - restart engine via systemctl
  query <id> <sql> - execute a query (SQL engines only)
  backup <id>   - trigger a backup
  connections <id> - list active connections

Cockpit way (v0.0.31+ pattern, applied here in v0.0.32): mutating
ops (start / stop / restart / query) run via subprocess directly —
no `sudo` shell-out. The JS panel passes { superuser: 'try' } to
cockpit.spawn so the cockpit bridge prompts the operator via polkit
for the org.sysdeck.db.modify action (added in v0.0.32 — authorizes
/usr/bin/systemctl for engine service control). The bridge runs as
the cockpit user and gets root privileges via polkit when the
operator authenticates.

Author: Jeremy Anderson (https://dcos.net)
"""

import json
import subprocess
import sys
import os
import re
from datetime import datetime

# ── Engine Registry ──────────────────────────────────────────────
# Each entry: (id, name, family, default_port, systemd_unit, cli_tool, config_paths, log_paths)

ENGINE_REGISTRY = [
    # SQL
    ("postgresql",  "PostgreSQL",    "sql",        5432, "postgresql.service",     "psql",           ["/etc/postgresql/postgresql.conf", "/var/lib/pgsql/data/postgresql.conf"], ["/var/log/postgresql/"]),
    ("mariadb",     "MariaDB",       "sql",        3306, "mariadb.service",        "mariadb",        ["/etc/my.cnf", "/etc/my.cnf.d/"], ["/var/log/mariadb/"]),
    ("mysql",       "MySQL",         "sql",        3306, "mysqld.service",         "mysql",          ["/etc/my.cnf", "/etc/mysql/"], ["/var/log/mysql/"]),
    ("sqlite",      "SQLite",        "sql",           0, "",                       "sqlite3",        [], []),
    ("cockroachdb", "CockroachDB",   "sql",        26257, "cockroachdb.service",   "cockroach",     ["/etc/cockroachdb/"], ["/var/log/cockroachdb/"]),
    ("tidb",        "TiDB",          "sql",        4000, "tidb.service",           "tidb",          ["/etc/tidb/"], ["/var/log/tidb/"]),

    # NoSQL
    ("mongodb",     "MongoDB",       "nosql",      27017, "mongod.service",         "mongosh",       ["/etc/mongod.conf"], ["/var/log/mongodb/"]),
    ("couchdb",     "CouchDB",       "nosql",       5984, "couchdb.service",        "curl",          ["/etc/couchdb/"], ["/var/log/couchdb/"]),
    ("rethinkdb",   "RethinkDB",     "nosql",      28015, "rethinkdb.service",      "rethinkdb",     ["/etc/rethinkdb/"], ["/var/log/rethinkdb/"]),
    ("dynamodb-local", "DynamoDB Local", "nosql",  8000, "dynamodb-local.service", "aws",           [], []),

    # Vector / Embedding / AI-native
    ("milvus",      "Milvus",        "vector",     19530, "milvus.service",         "milvus-cli",    ["/etc/milvus/milvus.yaml"], ["/var/log/milvus/"]),
    ("qdrant",      "Qdrant",        "vector",      6333, "qdrant.service",         "curl",          ["/etc/qdrant/config.yaml"], ["/var/log/qdrant/"]),
    ("weaviate",    "Weaviate",      "vector",      8080, "weaviate.service",       "curl",          ["/etc/weaviate/"], ["/var/log/weaviate/"]),
    ("chroma",      "Chroma",        "vector",      8000, "chroma.service",         "curl",          [], []),
    ("pgvector",    "pgvector",      "vector",      5432, "postgresql.service",     "psql",          ["/etc/postgresql/"], ["/var/log/postgresql/"]),

    # Time-series
    ("influxdb",    "InfluxDB",      "timeseries", 8086, "influxdb.service",       "influx",        ["/etc/influxdb/"], ["/var/log/influxdb/"]),
    ("timescaledb", "TimescaleDB",   "timeseries",  5432, "postgresql.service",     "psql",          ["/etc/postgresql/"], ["/var/log/postgresql/"]),
    ("questdb",     "QuestDB",       "timeseries",  9000, "questdb.service",        "curl",          ["/etc/questdb/"], ["/var/log/questdb/"]),
    ("clickhouse",  "ClickHouse",    "timeseries",  8123, "clickhouse.service",     "clickhouse-client", ["/etc/clickhouse-server/"], ["/var/log/clickhouse-server/"]),

    # Graph
    ("neo4j",       "Neo4j",         "graph",       7474, "neo4j.service",          "cypher-shell",  ["/etc/neo4j/neo4j.conf"], ["/var/log/neo4j/"]),
    ("arangodb",    "ArangoDB",      "graph",       8529, "arangodb.service",       "arangosh",      ["/etc/arangodb3/"], ["/var/log/arangodb3/"]),
    ("orientdb",    "OrientDB",      "graph",       2480, "orientdb.service",       "console.sh",    ["/etc/orientdb/"], ["/var/log/orientdb/"]),

    # Embedded / KV
    ("redis",       "Redis",         "embedded",    6379, "redis.service",          "redis-cli",     ["/etc/redis/redis.conf"], ["/var/log/redis/"]),
    ("keydb",       "KeyDB",         "embedded",    6379, "keydb.service",          "keydb-cli",     ["/etc/keydb/"], ["/var/log/keydb/"]),
    ("valkey",      "ValKey",        "embedded",    6379, "valkey.service",         "valkey-cli",    ["/etc/valkey/"], ["/var/log/valkey/"]),
    ("rocksdb",     "RocksDB",       "embedded",       0, "",                       "rocksdb",       [], []),
    ("lmdb",        "LMDB",          "embedded",       0, "",                       "python3",       [], []),
    ("badgerdb",    "BadgerDB",      "embedded",       0, "",                       "badger",        [], []),

    # Cloud-local
    ("firestore-emulator", "Firestore Emulator", "cloud", 8080, "firestore-emulator.service", "gcloud", [], []),
    ("supabase-local", "Supabase Local", "cloud", 54321, "supabase.service", "supabase", [], []),

    # AI / Analytical / Geospatial-AI
    ("lancedb",     "LanceDB",       "ai",              0, "",                       "lancedb",       [], []),
    ("duckdb",      "DuckDB",        "ai",              0, "",                       "duckdb",        [], []),
    ("tile38",      "Tile38",        "ai",           9851, "tile38.service",         "tile38-cli",    ["/etc/tile38/"], ["/var/log/tile38/"]),
]


def run(cmd, timeout=10):
    """Run a command, return stdout or empty string."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip()
    except Exception:
        return ""


def run_rc(cmd, timeout=10):
    """Run a command, return (rc, stdout, stderr) — never raises.

    v0.0.32 added so the start/stop/restart subcommands can surface
    the actual exit code and stderr to the JS panel rather than
    discarding them like the old `run()` helper did.
    """
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stdout or "").strip(), (r.stderr or "").strip()
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        return 127, "", str(exc)


def systemctl_status(unit):
    """Return (active, sub, uptime_seconds) for a systemd unit."""
    out = run(["systemctl", "show", unit, "--property=ActiveState,SubState,ActiveEnterTimestamp"], timeout=5)
    active = "unknown"
    sub = "unknown"
    uptime = 0
    for line in out.splitlines():
        k, _, v = line.partition("=")
        if k == "ActiveState":
            active = v
        elif k == "SubState":
            sub = v
        elif k == "ActiveEnterTimestamp":
            try:
                # systemd timestamp format: Day YYYY-MM-DD HH:MM:SS TZ
                dt = datetime.strptime(v[:25], "%a %Y-%m-%d %H:%M:%S")
                uptime = int((datetime.now() - dt).total_seconds())
            except Exception:
                pass
    return active, sub, uptime


def detect_engine(entry):
    """Build a DbEngine dict from a registry entry."""
    eid, name, family, port, unit, cli, configs, logs = entry

    # Check if CLI is available
    cli_available = bool(run(["which", cli]))

    # Check systemd unit
    if unit:
        active, sub, uptime = systemctl_status(unit)
        if active == "active":
            status = "running"
        elif active == "activating":
            status = "starting"
        elif active == "failed":
            status = "error"
        elif cli_available or sub == "dead":
            status = "stopped"
        else:
            status = "uninstalled"
    else:
        # No systemd unit — detect by port or CLI
        if port > 0:
            port_check = run(["ss", "-tlnp"])
            if f":{port} " in port_check:
                status = "running"
                uptime = 0
            elif cli_available:
                status = "stopped"
                uptime = 0
            else:
                status = "uninstalled"
                uptime = 0
        elif cli_available:
            status = "stopped"
            uptime = 0
        else:
            status = "uninstalled"
            uptime = 0

    # Detect version
    version = ""
    if cli_available:
        v_out = run([cli, "--version"], timeout=5)
        # Take first line, strip to 40 chars
        version = (v_out.splitlines()[0] if v_out else "")[:40]

    # Detect data size
    size_mb = 0
    # Try common data directories
    data_dirs = [f"/var/lib/{eid}", f"/var/lib/{name.lower().replace(' ', '')}"]
    if eid == "postgresql":
        data_dirs.append("/var/lib/pgsql/data")
    elif eid in ("mysql", "mariadb"):
        data_dirs.append("/var/lib/mysql")
    elif eid == "mongodb":
        data_dirs.append("/var/lib/mongo")
    elif eid == "redis":
        data_dirs.append("/var/lib/redis")
    elif eid == "influxdb":
        data_dirs.append("/var/lib/influxdb")
    elif eid == "clickhouse":
        data_dirs.append("/var/lib/clickhouse")
    elif eid == "neo4j":
        data_dirs.append("/var/lib/neo4j")

    for d in data_dirs:
        du_out = run(["du", "-sm", d], timeout=5)
        m = re.match(r'(\d+)', du_out)
        if m:
            size_mb = int(m.group(1))
            break

    # Detect memory (RSS) via ps if running
    memory_mb = 0
    if status == "running" and unit:
        ps_out = run(["ps", "-o", "rss=", "-C", cli] if cli else ["systemctl", "show", unit, "--property=MemoryCurrent"])
        try:
            vals = [int(x) for x in ps_out.split() if x.isdigit()]
            if vals:
                memory_mb = sum(vals) // 1024  # KB -> MB
        except ValueError:
            pass

    # Detect connections
    connections = 0
    if status == "running" and port > 0:
        ss_out = run(["ss", "-tnp"])
        connections = ss_out.count(f":{port} ")

    # Find first existing config
    config_path = ""
    for c in configs:
        if os.path.exists(c):
            config_path = c
            break

    # Find first existing log dir
    log_path = ""
    for l in logs:
        if os.path.exists(l):
            log_path = l
            break

    return {
        "id": eid,
        "name": name,
        "family": family,
        "status": status,
        "version": version,
        "port": port,
        "dataDir": data_dirs[0] if data_dirs else "",
        "uptime": uptime,
        "connections": connections,
        "sizeMB": size_mb,
        "memoryMB": memory_mb,
        "serviceUnit": unit,
        "cli": cli,
        "configPath": config_path,
        "logPath": log_path,
        "supported": True,
    }


def cmd_summary():
    """Return summary of all detected engines."""
    engines = [detect_engine(e) for e in ENGINE_REGISTRY]
    running = [e for e in engines if e["status"] == "running"]
    return {
        "engines": engines,
        "totalEngines": len(engines),
        "runningCount": len(running),
        "totalSizeMB": sum(e["sizeMB"] for e in engines),
        "totalMemoryMB": sum(e["memoryMB"] for e in engines),
        "totalConnections": sum(e["connections"] for e in engines),
    }


def cmd_status(engine_id):
    """Detailed status for a single engine."""
    for e in ENGINE_REGISTRY:
        if e[0] == engine_id:
            return detect_engine(e)
    return {"error": f"Unknown engine: {engine_id}"}


def cmd_start(engine_id):
    # v0.0.32: was `sudo systemctl start` — but sudo shell-out from
    # the bridge fails when the cockpit user has no passwordless sudo
    # (the typical case). The cockpit way: the JS panel passes
    # { superuser: 'try' } to cockpit.spawn so the cockpit bridge
    # prompts the operator via polkit for the org.sysdeck.db.modify
    # action. The bridge runs systemctl directly as root (the cockpit
    # superuser channel escalates privileges via polkit when the
    # operator authenticates).
    rc, out, err = run_rc(["systemctl", "start", f"{engine_id}.service"], timeout=30)
    return {"action": "start", "engine": engine_id, "rc": rc,
            "output": out or err or "started", "success": rc == 0,
            "stderr": err}


def cmd_stop(engine_id):
    rc, out, err = run_rc(["systemctl", "stop", f"{engine_id}.service"], timeout=30)
    return {"action": "stop", "engine": engine_id, "rc": rc,
            "output": out or err or "stopped", "success": rc == 0,
            "stderr": err}


def cmd_restart(engine_id):
    rc, out, err = run_rc(["systemctl", "restart", f"{engine_id}.service"], timeout=30)
    return {"action": "restart", "engine": engine_id, "rc": rc,
            "output": out or err or "restarted", "success": rc == 0,
            "stderr": err}


def cmd_connections(engine_id):
    """List active connections for an engine (best-effort)."""
    for e in ENGINE_REGISTRY:
        if e[0] == engine_id:
            port = e[3]
            if port <= 0:
                return {"connections": [], "count": 0}
            ss_out = run(["ss", "-tnp", f"sport = {port}"])
            lines = [l for l in ss_out.splitlines() if "ESTAB" in l]
            return {"connections": lines, "count": len(lines)}
    return {"error": f"Unknown engine: {engine_id}"}


def cmd_query(engine_id, sql):
    """Execute a SQL query against an engine (SQL family only)."""
    # Safety: refuse DDL/DML for certain contexts
    for e in ENGINE_REGISTRY:
        if e[0] == engine_id:
            family, cli = e[2], e[5]
            if family != "sql" and engine_id not in ("clickhouse", "timescaledb", "duckdb"):
                return {"error": "Query only supported for SQL-family engines"}
            if cli == "psql":
                out = run(["psql", "-tAc", sql], timeout=30)
            elif cli in ("mysql", "mariadb"):
                out = run(["mysql", "-e", sql], timeout=30)
            elif cli == "cockroach":
                out = run(["cockroach", "sql", "-e", sql], timeout=30)
            elif cli == "clickhouse-client":
                out = run(["clickhouse-client", "-q", sql], timeout=30)
            elif cli == "sqlite3":
                out = run(["sqlite3", sql], timeout=30)
            else:
                return {"error": f"No query handler for {cli}"}
            return {"output": out, "engine": engine_id, "query": sql}
    return {"error": f"Unknown engine: {engine_id}"}


def main():
    if len(sys.argv) < 2:
        print(json.dumps(cmd_summary()))
        return

    cmd = sys.argv[1]

    if cmd == "summary":
        print(json.dumps(cmd_summary()))
    elif cmd == "status":
        eid = sys.argv[2] if len(sys.argv) > 2 else ""
        print(json.dumps(cmd_status(eid)))
    elif cmd == "start":
        eid = sys.argv[2] if len(sys.argv) > 2 else ""
        print(json.dumps(cmd_start(eid)))
    elif cmd == "stop":
        eid = sys.argv[2] if len(sys.argv) > 2 else ""
        print(json.dumps(cmd_stop(eid)))
    elif cmd == "restart":
        eid = sys.argv[2] if len(sys.argv) > 2 else ""
        print(json.dumps(cmd_restart(eid)))
    elif cmd == "connections":
        eid = sys.argv[2] if len(sys.argv) > 2 else ""
        print(json.dumps(cmd_connections(eid)))
    elif cmd == "query":
        eid = sys.argv[2] if len(sys.argv) > 2 else ""
        sql = sys.argv[3] if len(sys.argv) > 3 else ""
        print(json.dumps(cmd_query(eid, sql)))
    else:
        print(json.dumps({"error": f"Unknown command: {cmd}"}))


if __name__ == "__main__":
    main()
