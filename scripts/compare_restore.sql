-- 復元照合用の正規化出力。元DBと復元DBで同じ出力になれば一致とみなす。
-- psql -tA -f で実行し、各行は「区分|名前|件数|ダイジェスト」。
-- 業務テーブル：全行のテキスト表現を並べ替えて連結したMD5（業務キー・金額・履歴番号をすべて含む）
SELECT format(
  'SELECT %L, %L, count(*), md5(coalesce(string_agg(t::text, E''\n'' ORDER BY t::text), '''')) FROM %I t',
  'table', tablename, tablename)
-- app_sessions（ログインセッション）は除外する。セッションは一時的な状態で、API利用のたびに
-- last_seen_at・expires_at が更新されるため、元DBと復元DBで必ず差分になる。
-- 利用者（app_users）は業務の一部として照合対象に残す。
FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'app_sessions' ORDER BY tablename
\gexec
-- 制約（主キー・外部キー・CHECK）
-- 定義文字列は型キャスト表記・括弧・空白を除いて比較する。varchar 列の IN (...) は pg_dump → 復元で
-- 「(ARRAY['a'::character varying])::text[]」が「ARRAY[('a'::character varying)::text]」に変わるなど、
-- 意味が同じでも表記が変わるため（2026-10-21 の反映リハーサルで chk_app_users_role が誤検知された）。
SELECT 'constraint', conrelid::regclass::text || '.' || conname, 1,
       md5(regexp_replace(regexp_replace(pg_get_constraintdef(oid), '::[a-z ]+(\[\])?', '', 'g'), '[()[:space:]]', '', 'g'))
FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 2;
-- トリガー（承認済み改定の上書き禁止など）
SELECT 'trigger', tgrelid::regclass::text || '.' || tgname, 1, md5(pg_get_triggerdef(oid))
FROM pg_trigger WHERE NOT tgisinternal ORDER BY 2;
-- 関数
SELECT 'function', proname, 1, md5(prosrc)
FROM pg_proc WHERE pronamespace = 'public'::regnamespace ORDER BY 2;
-- インデックス
SELECT 'index', indexrelid::regclass::text, 1, md5(pg_get_indexdef(indexrelid))
FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
WHERE c.relnamespace = 'public'::regnamespace ORDER BY 2;
