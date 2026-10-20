# OpenCode Agent Instructions

## Repository Context
This is a reverse-engineering and static analysis repository for **ガリバー・プロステージ v6.2.0** (Gulliver ProStage, codename: `Sirius`), a legacy .NET 4.0 Windows Forms Client/Server construction ERP system. 
The codebase contains decompiled C# assemblies, decrypted InstallShield scripts, Python analysis tools, and detailed reverse-engineered specification documents.

## Architectural & Data Model Constraints
When generating schemas, SQL, or application code based on this domain, **strictly adhere to the following rules** from `建設業特有業務データモデル仕様書.md`. Do not use generic web framework defaults.

- **Multi-Tenancy**: Every table must use `company_code CHAR(4)` as the first column of its composite primary key. Auto-incrementing surrogate keys (`id`) should not replace business composite keys.
- **No Floating Point**: NEVER use `FLOAT` or `DOUBLE` for financial or quantity calculations.
  - Currency/Amounts: `NUMERIC(15,0)` (Japanese Yen, no decimal places).
  - Quantities/Rates/Unit Prices: `NUMERIC(15,3)`.
- **Immutable Revisions**: Estimates, Execution Budgets, and Contracts cannot be updated in-place (no `UPDATE`). You must issue a new record by incrementing `history_no SMALLINT`.
- **Unified Business Partners**: Do not split customers, suppliers, and subcontractors into separate tables. Use a single `business_partners` table with multi-role boolean flags (`is_customer`, `is_subcontractor`, `is_supplier`, etc.).
- **Hierarchical Codes**: Work type codes (`work_type_code`) are strictly 12 characters (4-char Major, 4-char Middle, 4-char Minor).

## Legacy System Quirks
- **Database**: PostgreSQL (via ODBC, `psqlODBC 09.02.0100` ANSI) or Oracle.
- **Framework**: .NET Framework 4.0 (`v4.0.30319`) with `useLegacyV2RuntimeActivationPolicy="true"`.
- **UI Components**: Infragistics NetAdvantage v10.3 and GrapeCity InputMan/PlusPak v6.0.
- **Encryption**: Custom DES encryption using `Shift-JIS` encoding and the hardcoded key `"AsakawaSystems19840704"`. The `ASK` license file is decrypted/re-encrypted *in-place*, which is a known data-corruption risk to be aware of.

## Directory Structure
- `01_DotNet_Assemblies_and_Decompiled/`: Decompiled C# sources. Treat as read-only reference.
- `02_InstallShield_Decrypted_and_Scripts/`: Decrypted InstallShield bytecodes (`setup.inx`).
- `03_Analysis_Tools_and_Scripts/`: Python scripts used for decryption and analysis.
- `*.md`: The absolute source of truth for the domain model and system architecture.

## Working Guidelines
- **Read Specs First**: Always refer to `00_ガリバー・プロステージ_v6.2.0_静的解析レポート.md` and `建設業特有業務データモデル仕様書.md` before making assumptions about the business logic.
- **Language**: Use Japanese for user-facing text, domain terminology (e.g., 出面, 実行予算, 出来高査定), and code comments, as the domain relies heavily on specialized Japanese construction accounting terms.