import React, { useState } from "react";
import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, Body1, Body1Strong, Button, Caption1, Divider, Field, Input, Select, Slider, Textarea, useRestoreFocusTarget } from "@fluentui/react-components";
import { LookupsDto } from "./bindings";
import { CostDraft, InputMode } from "./useCostDraft";
import { formatYen } from "./cockpitData";
import { Notice, usePageStyles } from "./ui";

type FieldProps = { draft: CostDraft; name: string; label: string; hint?: string; required?: boolean; children: React.ReactElement };
function FormField({ draft, name, label, hint, required = true, children }: FieldProps) {
  const p = usePageStyles(); const error = draft.fieldError(name);
  return <Field className={p.compact} label={label} required={required} hint={hint} validationState={error ? "error" : "none"} validationMessage={error} onBlur={() => draft.touch(name)}>{children}</Field>;
}
type TextFieldProps = Omit<FieldProps, "children"> & { id: string; value: string; onChange: (value: string) => void; type?: "text" | "date" | "month"; decimal?: boolean; unit?: string; maxLength?: number };
function TextField({ id, value, onChange, type = "text", decimal, unit, maxLength, ...props }: TextFieldProps) {
  const p = usePageStyles();
  return <FormField {...props}><Input id={id} className={p.control} size="large" value={value} onChange={(_, data) => onChange(data.value)} type={type} inputMode={decimal ? "decimal" : undefined} contentAfter={unit} maxLength={maxLength} disabled={props.draft.isSubmitting} /></FormField>;
}
function ChoiceField({ id, value, onChange, options, placeholder, ...props }: Omit<FieldProps, "children"> & { id: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; placeholder?: string }) {
  const p = usePageStyles(); const restoreFocus = useRestoreFocusTarget();
  return <FormField {...props}><Select select={{ as: "select", ...restoreFocus }} id={id} className={p.control} size="large" value={value} onChange={(_, data) => onChange(data.value)} disabled={props.draft.isSubmitting}><option value="">{placeholder ?? "選択してください"}</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></FormField>;
}
function OptionalDetails({ children, forceOpen = false, title = "詳細・任意項目" }: { children: React.ReactNode; forceOpen?: boolean; title?: string }) {
  const [open, setOpen] = useState(false);
  return <Accordion collapsible openItems={open || forceOpen ? ["details"] : []} onToggle={(_, data) => setOpen(data.openItems.includes("details"))}><AccordionItem value="details"><AccordionHeader expandIconPosition="end">{title}</AccordionHeader><AccordionPanel>{children}</AccordionPanel></AccordionItem></Accordion>;
}
const workOptions = (lookups: LookupsDto) => lookups.work_types.map(item => ({ value: item.work_type_code, label: `${item.work_type_name} · ${item.work_type_code}` }));
export function SubcontractForm({ draft: d, onChangeOrder }: { draft: CostDraft; onChangeOrder: (value: string) => void }) {
  const p = usePageStyles(); const v = d.sub; const calc = d.subPreview; const order = d.order;
  return <div className={p.stack}>
    <ChoiceField draft={d} name="order" label="発注先・作業内容" id="subcontract-order-select" value={v.orderNo} onChange={onChangeOrder} options={d.orders.map(item => ({ value: item.order_number, label: `${item.subcontractor_name} · ${item.work_type_name}（${item.order_number}）` }))} />
    {d.orders.length === 0 && <Notice>この工事の承認済み発注はありません。発注内容を管理者にご確認ください。</Notice>}
    {order && <div className={p.inset}><div className={p.compact}><div className={p.spread}><Body1>発注額（税抜）</Body1><Body1Strong>{formatYen(order.order_amount_tax_ex)}</Body1Strong></div><div className={p.spread}><Body1>前回までの出来高</Body1><Body1Strong>{formatYen(order.accum_assessed_amount_tax_ex)}</Body1Strong></div><div className={p.spread}><Caption1>発注残高</Caption1><Caption1>{formatYen(order.remaining_order_balance)}</Caption1></div></div></div>}
    <TextField draft={d} name="month" label="対象年月" id="subcontract-ym-input" type="month" value={v.month} onChange={month => d.updateSub({ month })} />
    <div className={p.compact}><TextField draft={d} name="progress" label="今回までの累計出来高" hint="今回だけの増加率ではなく、工事の開始からの合計を入力します。" id="subcontract-progress-input" value={v.progress} onChange={d.setProgress} decimal unit="%" /><Slider aria-label="累計出来高の調整" min={0} max={100} step={0.1} value={Number.isFinite(Number(v.progress)) ? Math.max(0, Math.min(100, Number(v.progress))) : 0} onChange={(_, data) => d.setProgress(String(data.value))} disabled={d.isSubmitting || !order} /><div className={p.spread}><Caption1 className={p.muted}>0%</Caption1><Caption1 className={p.muted}>100%（完了）</Caption1></div></div>
    <TextField draft={d} name="amount" label="今回の出来高金額（税抜）" hint="累計出来高から前回までの金額を引いて計算します。金額を直接入力することもできます。" id="subcontract-curr-amount" value={v.amount} onChange={d.setSubAmount} decimal unit="円" />
    <OptionalDetails title="控除・税額の詳細" forceOpen={v.fixed !== "0" || v.offset !== "0" || !!d.fieldError("fixed") || !!d.fieldError("offset")}><div className={p.stack}>
      <div className={p.fields}><TextField draft={d} name="fixed" label="定額控除額" id="subcontract-fixed-deduction" value={v.fixed} onChange={fixed => d.updateSub({ fixed })} decimal unit="円" required={false} /><TextField draft={d} name="offset" label="立替相殺額" id="subcontract-chargeback-offset" value={v.offset} onChange={offset => d.updateSub({ offset })} decimal unit="円" required={false} /></div>
      <Divider />{([['今回消費税', calc.tax], ['保留金', calc.retainage], ['安全協力会費', calc.safety], ['控除合計', calc.deductions], ['差引支払額（概算）', calc.net]] as [string, number][]).map(([label, amount]) => <div className={p.spread} key={label}><Body1>{label}</Body1><Body1Strong>{formatYen(amount)}</Body1Strong></div>)}<Caption1 className={p.muted}>契約の税率・控除率で計算します。工事原価には控除前の税抜出来高を反映します。</Caption1>
    </div></OptionalDetails>
  </div>;
}
export function DirectForm({ draft: d, lookups, onTemplate }: { draft: CostDraft; lookups: LookupsDto; onTemplate: (value: string) => void }) {
  const p = usePageStyles(); const v = d.direct; const restoreFocus = useRestoreFocusTarget();
  return <div className={p.stack}>
    <div className={p.compact}><Body1Strong>よく使う品目から入力</Body1Strong><div className={p.row}>{lookups.quick_templates.map(tpl => <Button {...restoreFocus} key={tpl.template_code} size="large" appearance={v.templateCode === tpl.template_code ? "primary" : "secondary"} aria-pressed={v.templateCode === tpl.template_code} disabled={d.isSubmitting} onClick={() => onTemplate(tpl.template_code)}>{tpl.item_label}</Button>)}</div><Caption1 className={p.muted}>品目を選ぶと、作業内容・単位・単価が入力されます。下の項目から変更もできます。</Caption1></div>
    <Divider />
    <div className={p.fields}>
      <TextField draft={d} name="date" label="発生日" id="direct-occurred-date" type="date" value={v.date} onChange={date => d.updateDirect({ date })} />
      <ChoiceField draft={d} name="costElement" label="種類" id="direct-cost-element-select" value={v.costElement} onChange={value => d.updateDirect({ costElement: value as typeof v.costElement })} options={[{ value: "0100", label: "材料費" }, { value: "0400", label: "現場経費" }]} />
      <TextField draft={d} name="itemName" label="品名・内容" id="direct-item-name-input" value={v.itemName} onChange={itemName => d.updateDirect({ itemName })} maxLength={100} />
      <ChoiceField draft={d} name="workType" label="作業内容（工種）" id="direct-work-type-select" value={v.workType} onChange={workType => d.updateDirect({ workType })} options={workOptions(lookups)} />
      <TextField draft={d} name="quantity" label="数量" id="direct-quantity-input" value={v.quantity} onChange={quantity => d.updateDirect({ quantity })} decimal />
      <TextField draft={d} name="unit" label="単位" hint="例：m3、t、式" id="direct-unit-input" value={v.unit} onChange={unit => d.updateDirect({ unit })} maxLength={10} />
      <TextField draft={d} name="price" label="単価" id="direct-unit-price-input" value={v.price} onChange={price => d.updateDirect({ price })} decimal unit="円" />
    </div>
    <OptionalDetails forceOpen={!!(v.specification || v.vendor || v.notes)}><div className={p.stack}>
      <TextField draft={d} name="specification" label="仕様・規格" id="direct-specification-input" value={v.specification} onChange={specification => d.updateDirect({ specification })} required={false} maxLength={200} />
      <ChoiceField draft={d} name="vendor" label="購入先" id="direct-vendor-select" value={v.vendor} onChange={vendor => d.updateDirect({ vendor })} required={false} placeholder="未指定" options={lookups.suppliers.map(item => ({ value: item.partner_code, label: `${item.partner_name} · ${item.partner_code}` }))} />
      <FormField draft={d} name="notes" label="備考" required={false}><Textarea id="direct-notes-input" value={v.notes} onChange={(_, data) => d.updateDirect({ notes: data.value })} disabled={d.isSubmitting} resize="vertical" maxLength={500} /></FormField>
    </div></OptionalDetails>
  </div>;
}
export function DailyForm({ draft: d, lookups }: { draft: CostDraft; lookups: LookupsDto }) {
  const p = usePageStyles(); const v = d.daily;
  return <div className={p.stack}><div className={p.fields}>
    <TextField draft={d} name="date" label="作業日" id="daily-work-date-input" type="date" value={v.date} onChange={date => d.updateDaily({ date })} />
    <ChoiceField draft={d} name="employee" label="作業員" id="daily-employee-select" value={v.employee} onChange={employee => d.updateDaily({ employee })} options={lookups.employees.map(item => ({ value: item.employee_code, label: `${item.employee_name} · ${item.employee_code}` }))} />
    <ChoiceField draft={d} name="workType" label="作業内容（工種）" id="daily-work-type-select" value={v.workType} onChange={workType => d.updateDaily({ workType })} options={workOptions(lookups)} />
    <TextField draft={d} name="hours" label="作業時間" hint="休憩を除いた実際の時間（24時間以内）" id="daily-work-hours-input" value={v.hours} onChange={hours => d.updateDaily({ hours })} decimal unit="時間" />
  </div><div className={p.row} aria-label="作業時間の候補">{['4.0', '8.0'].map(hours => <Button size="large" key={hours} aria-pressed={v.hours === hours} appearance={v.hours === hours ? "primary" : "secondary"} onClick={() => d.updateDaily({ hours })} disabled={d.isSubmitting}>{hours}時間{hours === '4.0' ? '（半日）' : '（1日）'}</Button>)}</div>
    <OptionalDetails title="作業メモ（任意）" forceOpen={!!v.summary}><FormField draft={d} name="summary" label="作業メモ" required={false}><Textarea id="daily-work-summary-input" resize="vertical" value={v.summary} onChange={(_, data) => d.updateDaily({ summary: data.value })} disabled={d.isSubmitting} maxLength={500} /></FormField></OptionalDetails>
    <Notice>労務費は標準日額を8時間で割った概算です。月次の確定賃金による金額とは異なります。</Notice>
  </div>;
}
export function EquipmentForm({ draft: d, lookups }: { draft: CostDraft; lookups: LookupsDto }) {
  const p = usePageStyles(); const v = d.equip;
  return <div className={p.stack}><div className={p.fields}>
    <ChoiceField draft={d} name="equipment" label="使用する資機材・重機" id="equip-select" value={v.equipment} onChange={equipment => d.updateEquip({ equipment })} options={lookups.equipments.map(item => ({ value: item.equipment_code, label: `${item.equipment_name} · ${item.equipment_code}` }))} />
    <TextField draft={d} name="date" label="出庫日" id="equip-movement-date-input" type="date" value={v.date} onChange={date => d.updateEquip({ date })} />
    <ChoiceField draft={d} name="workType" label="作業内容（工種）" id="equip-work-type-select" value={v.workType} onChange={workType => d.updateEquip({ workType })} options={workOptions(lookups)} />
    <TextField draft={d} name="quantity" label="数量" id="equip-quantity-input" value={v.quantity} onChange={quantity => d.updateEquip({ quantity })} decimal unit={d.equipment?.unit} />
    <TextField draft={d} name="days" label="使用日数" id="equip-usage-days-input" value={v.days} onChange={days => d.updateEquip({ days })} decimal unit="日" />
  </div>{d.equipment && <div className={p.inset}><div className={p.spread}><Body1>1日あたりの単価（1{d.equipment.unit}）</Body1><Body1Strong>{new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 3 }).format(Number(d.equipment.daily_rent_price))}円</Body1Strong></div></div>}
    <OptionalDetails title="運賃・整備費（任意）" forceOpen={v.freight !== "0" || v.maintenance !== "0" || !!d.fieldError("freight") || !!d.fieldError("maintenance")}><div className={p.fields}>
      <TextField draft={d} name="freight" label="運賃・回送費" id="equip-freight-input" value={v.freight} onChange={freight => d.updateEquip({ freight })} decimal unit="円" required={false} />
      <TextField draft={d} name="maintenance" label="整備・基本料" id="equip-maintenance-input" value={v.maintenance} onChange={maintenance => d.updateEquip({ maintenance })} decimal unit="円" required={false} />
    </div></OptionalDetails>
  </div>;
}
export const modeDescriptions: Record<InputMode, string> = { subcontract: "外注先の工事がどこまで進んだかを記録します。", direct: "購入した材料や、現場でかかった経費を記録します。", daily: "だれが、どの作業を、何時間行ったかを記録します。", equipment: "現場へ出庫する資機材と使用日数を記録します。" };
