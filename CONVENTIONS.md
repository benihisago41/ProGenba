# Project Sirius Reborn — Aider 絶対遵守規約 (CONVENTIONS.md)

本書は全セッションで Read-Only として注入される不変の設計契約（Single Source of Truth）である。

## 1. スコープ制約（経理・会計機能の完全禁止）
- 本フェーズの目的は **「実際の工事（本工事・追加工事）で、実行予算に対して今いくら原価（外注費・材料費・労務出面・経費/機械損料）が発生し、見込粗利がいくらか」** を前提知識ゼロで記録・可視化することにある。
- **禁止事項**: 複式簿記（仕訳伝票 `journal_entry`、勘定科目、借方/貸方、未成工事支出金・完成工事原価の振替仕訳）、支払手形サイト管理、銀行入金消込、JV按分は **絶対に実装・言及してはならない**。
- **UI表現**: 画面に「借方」「貸方」「勘定科目」「仕訳」等の経理用語を表示してはならない。freeeのように「どの工事で」「何が（出来高％・購入品目・作業時間・機材出庫）発生したか」のみを入力させること。

## 2. データベース・型システムの絶対制約（違反時は即ビルド失敗）
1. **マルチテナント複合主キー**:
   - 全テーブルの第1カラムは `company_code CHAR(4)`（既定 `'0000'`）とし、業務コードとの複合主キーとする。
   - `id SERIAL` や `UUID` 等のサロゲート主キーの追加は **厳禁**。
2. **浮動小数点数の完全禁止**:
   - Rustの `f32`, `f64`、SQLの `FLOAT`, `DOUBLE PRECISION`, `REAL` は **使用厳禁**。
   - **金額（Currency）**: DB `NUMERIC(15,0)` / Rust `YenAmount(pub i64)`（日本円整数、端数なし）。
   - **数量・単価・工数・進捗率**: DB `NUMERIC(15,3)` / Rust `Quantity(pub Decimal)`, `UnitPrice(pub Decimal)`（小数3桁）。
   - **比率・率**: DB `NUMERIC(5,2)` / Rust `Rate(pub Decimal)`（小数2桁）。
3. **不変改定履歴（Immutable Revision）**:
   - 実行予算（`execution_budgets`）および下請注文書（`subcontract_orders`）は承認後の `UPDATE` を禁止する。
   - 内容変更時は既存の最大 `history_no SMALLINT` に `+1` した新レコードを `INSERT` すること。
   - 集計時は常に各キーの **最新（最大 `history_no`）かつ承認済（`approval_status = '1'`）** のレコードのみを参照する。
4. **コード体系と4大原価要素**:
   - **工事枝コード (`branch_code`)**: `CHAR(3)`（本工事 = `'000'`, 追加工事 = `'001'`〜`'999'`）。
   - **工種コード (`work_type_code`)**: `VARCHAR(12)`（大工種4桁 + 中工種4桁 + 小工種4桁の厳密12文字）。
   - **原価要素大区分 (`element_category`)**: `'10'`=材料費, `'20'`=労務費, `'30'`=外注費, `'40'`=経費, `'50'`=機械損料。
   - **完成区分ガード (`completion_status`)**:
     - `'0'`=未成（原価登録可）
     - `'1'`=完成（警告付きで原価登録可）
     - `'2'`=前期完成 / `'3'`=計上ロック済（**新規の原価・日報・査定登録は HTTP 422 エラーで完全遮断**）

## 3. 決定論的・原価計算アルゴリズム（1円の誤差も許さない端数規則）

### 3.1 明細金額の算出（四捨五入）
- 実行予算明細・注文明細・材料経費明細の金額：
  `amount = round_half_up(quantity * unit_price, 0)`（小数第1位を四捨五入して整数円 `YenAmount` に変換）

### 3.2 下請出来高査定および控除計算パイプライン（`calc.rs`）
1. **今回査定税抜額**: `curr_assessed_tax_ex = sum(round_half_up(assessed_qty_i * contract_unit_price_i, 0))`
2. **消費税額（累計差額方式・端数切捨）**:
   - `accum_tax_curr = floor((prev_accum_assessed_tax_ex + curr_assessed_tax_ex) * tax_rate)`
   - `curr_tax_amount = accum_tax_curr - prev_accum_tax_amount`
3. **保留金控除額（端数切捨）**:
   - `retainage = floor(curr_assessed_tax_ex * retainage_rate_num / retainage_rate_den)`
4. **安全協力会費控除額（端数切捨）**:
   - `safety_fee = floor(curr_assessed_tax_ex * safety_rate_num / safety_rate_den)`
5. **差引支払実額**:
   - `total_deduction = retainage + safety_fee + fixed_deduction + chargeback_offset`
   - `net_payment = (curr_assessed_tax_ex + curr_tax_amount) - total_deduction`
   - ※工事原価（外注費）として工事台帳へ計上する実発生原価は、控除前の **`curr_assessed_tax_ex`（税抜出来高）** である（保留金や協力会費は支払時の控除であり原価自体は減らないため）。

### 3.3 労務費（直営・出面日報）按分アルゴリズム（`calc.rs`）
- 作業員 $W$ の月次確定賃金総額 `total_wage` を、各工事枝番 $j$ の従事工数 `hours_j`（総工数 `total_hours`）で按分：
  1. 各工事の基礎配賦額: `base_cost_j = floor(total_wage * hours_j / total_hours)`
  2. 端数差額: `delta = total_wage - sum(base_cost_j)`
  3. 端数寄先: `hours_j` が最大の工事枝番（同数の場合は先頭）に `delta` を加算し、配賦合計を `total_wage` と1円の狂いもなく一致させる。
  4. 月次賃金確定前のリアルタイム概算表示時は、`round_half_up(daily_standard_wage * (hours_j / 8.0), 0)` を概算労務原価として集計する。

### 3.4 資機材・機械損料の自動原価計算
- 現場への出庫（`movement_type = '02'`）または精算（`'10'`）において、`round_half_up(quantity * daily_rent_price * days, 0) + freight_fee + maintenance_fee` を機械損料（`'50'`）の実発生原価として集計する。

## 4. アンカーファイルの保護ルール
- `CONVENTIONS.md`, `migrations/001_core_cost_schema.sql`, `backend/src/domain/types.rs`, `frontend/src/bindings.ts` は **ロック済アンカー** である。指示されたセッション以外でこれらを変更してはならない。

## 5. Phase 0で確定した実装契約
- 率の分母は `NUMERIC(7,2)` とし、`1000.00` を格納可能にする。分子は0以上、分母は正数。
- DecimalのAPI表現はJSON文字列、円金額はJSON整数。金額はDBの15桁以内に収める。
- 出来高入力は累計進捗率。今回額は「契約額×累計進捗率（四捨五入）−前回査定累計」で計算し、負額・発注超過を拒否する。
- プレビューの税率・控除率・累計税額は取得APIの契約実値を用いる。表示は概算であり登録時のサーバー計算を正とする。
- 率の分母0、不正精度、負数、会社違いの参照を拒否する。費目は材料0100・経費0400に限定。
- 登録成功はHTTP 201と `CostRegistrationResponse`、業務入力不正は422、対象不存在404、履歴競合409。JSON不正も共通エラー形式を返す。
- 完成区分1と社内工期超過は警告付き登録。区分2/3は拒否。権限承認は今回未対応。
- 伝票番号は12桁の業務番号。会社・伝票種別ごとのトランザクション排他を使い、採番・ガード・登録の途中失敗時は全てロールバックする。
- 承認済予算と発注の履歴は参照専用。最新承認済履歴を選び、各原価を独立集計してから結合する。
- 監理技術者警告の4,500万円は提供資料の検証用業務設定であり、現行法適合を保証する表示にしない。
- 配布はアプリとPostgreSQL 16の2サービス。認証・権限は未対応のため限定社内検証用。
