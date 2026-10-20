# Phase 0: 実装前の最小契約整備

今回の編集担当は migrations/001_core_cost_schema.sql, backend/src/domain/types.rs, frontend/src/bindings.ts の3つだけ。他者の変更を戻さず、他ファイル編集・コマンド実行・依存追加・コミット・pushをしない。今回は管理者が明示承認した契約修正である。これ以降はアンカーとして固定する。

1. DDLの safety_assoc_rate_den と retainage_rate_den を全テーブルで NUMERIC(7,2) とし、分子・分母双方とも0未満を認めず分母は正とするCHECKを追加。DEFAULT 1000.00 が入らない問題を修正。契約金額・その他の型・データ・テーブル名は維持。
2. Rust Quantity/UnitPrice/Rateの透明newtypeにおけるDecimalのSerialize/Deserializeを rust_decimal::serde::str で明示してJSON文字列とする。YenAmountは整数維持。
3. bindings.tsにあるQuickItemTemplateDtoとSubcontractOrderSummaryDtoをRust側にも同じフィールドで追加する。SubcontractOrderSummaryDtoには両言語で tax_rate, retainage_rate_num, retainage_rate_den, safety_assoc_rate_num, safety_assoc_rate_den をDecimal文字列、accum_assessed_tax_amountをYenAmountで追加。
4. 次のDTOをRust/TS双方で定義。WorkTypeLookupDto {work_type_code,work_type_name}; EmployeeLookupDto {employee_code,employee_name,standard_daily_wage:YenAmount}; SupplierLookupDto {partner_code,partner_name}; EquipmentLookupDto {equipment_code,equipment_name,unit,daily_rent_price:UnitPrice(=TS DecimalString)}; LookupsDto {quick_templates,subcontract_orders,work_types,employees,suppliers,equipments} は各DTO配列。
5. 共通成功DTO CostRegistrationResponse {document_no:String(=TS string),warnings:Vec<String>(=TS string[])} と共通ErrorResponse {code,message} を追加。
6. 既存の型・リクエスト・API_ENDPOINTSは削除・変更しない。追加フィールドは上記のみ。Rust f32/f64は禁止。

最後に変更内容と未実行検証を日本語で報告。管理者がDBおよびJSON契約を別途テストする。
