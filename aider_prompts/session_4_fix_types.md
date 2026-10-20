# Session4 strict型検査の修復

編集はfrontend/src/EasyCostInput.tsxのみ。他者の変更を戻さず、アンカー/tsconfig/依存/他ファイルを変えない。コマンド・commit・pushは禁止。

npm run buildで次を検出:
src/EasyCostInput.tsx(325,30): error TS18048: 'firstOrder' is possibly 'undefined'.
src/EasyCostInput.tsx(326,30): error TS2345: Argument of type 'SubcontractOrderSummaryDto | undefined' is not assignable to parameter of type 'SubcontractOrderSummaryDto | null'.
src/EasyCostInput.tsx(638,26): error TS2345: Argument of type 'QuickItemTemplateDto | undefined' is not assignable to parameter of type 'QuickItemTemplateDto'.
src/EasyCostInput.tsx(828,28): error TS2532: Object is possibly 'undefined'.
src/EasyCostInput.tsx(831,28): error TS2532: Object is possibly 'undefined'.
src/EasyCostInput.tsx(834,20): error TS2532: Object is possibly 'undefined'.
src/EasyCostInput.tsx(837,28): error TS2532: Object is possibly 'undefined'.

配列の先頭要素をローカル変数へ取り出し、存在を明示ガードしてから使用する。型設定の緩和・non-null assertionによる隠蔽はしない。空の発注/テンプレートでも安全に表示する。全4入力方式と計算・再入防止は維持する。
同ファイルに英語だけのコードコメント（ignore parse error等）があれば日本語へ置換する。報告は短く。
