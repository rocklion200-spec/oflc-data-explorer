"""One-off pass: re-encode published parquet at zstd level 22.

Level 22 is ~10% smaller than the level-3 default across the published tree and
costs nothing at read time (zstd decompression speed is independent of level),
which buys headroom against Pages' 1 GB hard limit on the published site.

This re-encodes in place rather than re-staging: the row order that row-group
pruning depends on is physical file order, and a plain SELECT * -> COPY
preserves it (verified per file below, not assumed). Row-group size is read
back from each file's own metadata so the pruning granularity is unchanged.

Once pipeline/convert.py and pipeline/wages.py write level 22 themselves this
script is only needed for trees published before that change.
"""
import json
import pathlib
import sys
import time

import duckdb

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB_DATA = ROOT / "web" / "public" / "data"
LEVEL = 22


def row_group_size(con: duckdb.DuckDBPyConnection, f: pathlib.Path) -> int:
    # preserve the file's existing granularity: convert.py uses 65536 for cubes
    # and the DuckDB default for row parquet, and pruning depends on it
    n = con.execute("SELECT max(row_group_num_rows) FROM parquet_metadata(?)",
                    [f.as_posix()]).fetchone()[0]
    return int(n) if n else 122880


def verify(con: duckdb.DuckDBPyConnection, a: pathlib.Path, b: pathlib.Path) -> str | None:
    """Return an error string if b is not a faithful re-encode of a."""
    na, nb = (con.execute(f"SELECT count(*) FROM '{p.as_posix()}'").fetchone()[0] for p in (a, b))
    if na != nb:
        return f"row count {na:,} -> {nb:,}"
    # join on the true physical row index and compare whole rows, so this
    # catches both changed values and any reordering. The table aliases must
    # not collide with a column name — the cubes have a column called "n", and
    # hash(n) would silently hash that column instead of the whole row.
    bad = con.execute(f"""
        SELECT count(*) FROM
          (SELECT file_row_number frn, hash(t_old) h FROM read_parquet('{a.as_posix()}',
             file_row_number=true) t_old) x
        JOIN
          (SELECT file_row_number frn, hash(t_new) h FROM read_parquet('{b.as_posix()}',
             file_row_number=true) t_new) y
        USING (frn)
        WHERE x.h IS DISTINCT FROM y.h
    """).fetchone()[0]
    return f"{bad:,} rows differ" if bad else None


def main() -> None:
    files = sorted(p for p in WEB_DATA.rglob("*.parquet") if ".git" not in p.parts)
    if not files:
        raise SystemExit(f"no parquet under {WEB_DATA}")
    con = duckdb.connect()
    tmp_dir = WEB_DATA / ".recompress"
    tmp_dir.mkdir(exist_ok=True)
    before = after = 0
    failed = []
    for i, f in enumerate(files, 1):
        src = f.stat().st_size
        tmp = tmp_dir / f.name
        st = time.time()
        con.execute(f"""
            COPY (SELECT * FROM '{f.as_posix()}') TO '{tmp.as_posix()}'
            (FORMAT parquet, COMPRESSION zstd, COMPRESSION_LEVEL {LEVEL},
             ROW_GROUP_SIZE {row_group_size(con, f)})
        """)
        err = verify(con, f, tmp)
        if err:
            failed.append((f.name, err))
            print(f"[{i}/{len(files)}] FAIL {f.name}: {err} — left unchanged", flush=True)
            tmp.unlink(missing_ok=True)
            after += src
            before += src
            continue
        new = tmp.stat().st_size
        tmp.replace(f)  # atomic within the same filesystem
        before += src
        after += new
        print(f"[{i}/{len(files)}] {f.relative_to(WEB_DATA)}: "
              f"{src/1048576:.1f}M -> {new/1048576:.1f}M "
              f"({100*(src-new)/src:.1f}% saved, {time.time()-st:.0f}s)", flush=True)
    tmp_dir.rmdir()

    # datasets.json records each file's size and cache.js fingerprints the
    # localStorage cache on the sum, so it has to follow the new sizes
    man = WEB_DATA / "datasets.json"
    doc = json.loads(man.read_text())
    patched = 0

    def walk(node):
        nonlocal patched
        if isinstance(node, dict):
            name = node.get("file")
            if isinstance(name, str) and name.endswith(".parquet") and "bytes" in node:
                p = WEB_DATA / name
                if p.exists() and node["bytes"] != p.stat().st_size:
                    node["bytes"] = p.stat().st_size
                    patched += 1
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)

    walk(doc)
    man.write_text(json.dumps(doc, separators=(",", ":")))
    print(f"\ndatasets.json: {patched} byte counts updated")
    print(f"published tree: {before/1048576:.1f} MiB -> {after/1048576:.1f} MiB "
          f"({(before-after)/1048576:.1f} MiB saved)")
    print(f"headroom under Pages' 1 GiB: {(1073741824-after)/1048576:.1f} MiB")
    if failed:
        print(f"\n{len(failed)} file(s) failed verification and were left unchanged:")
        for n, e in failed:
            print(f"  {n}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
