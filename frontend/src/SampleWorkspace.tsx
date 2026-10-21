import { useEffect, useState } from "react";
import { Badge, Button, Card, Title3 } from "@fluentui/react-components";
import { CockpitView } from "./CockpitView";
import { EasyCostInput } from "./EasyCostInput";
import type { ProjectSelection } from "./data";
import { sampleLookups, sampleProjects } from "./sampleData";
import { ConfirmDialog, Notice, ThemeButton, usePageStyles } from "./ui";

export function SampleWorkspace({ onExit }: { onExit: () => void }) {
  const p = usePageStyles();
  const [tab, setTab] = useState<"cockpit" | "input">("cockpit");
  const [selection, setSelection] = useState<ProjectSelection>({ projectCode: "SAMPLE001", branchCode: "000" });
  const [dirty, setDirty] = useState(false);
  const [version, setVersion] = useState(0);
  const [pending, setPending] = useState<ProjectSelection | "exit" | null>(null);
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  const choose = (next: ProjectSelection) => {
    if (next.projectCode === selection.projectCode && next.branchCode === selection.branchCode) return;
    if (dirty) { setPending(next); return; }
    setSelection(next); setVersion(v => v + 1);
  };
  return <main className={p.stack} style={{ maxWidth: 1440, margin: "0 auto", padding: 24 }}>
    <Card className={p.card}><div className={p.spread}><div className={p.row}><Title3 as="span">ProGenba</Title3><Badge color="warning" appearance="tint">サンプル表示</Badge></div><div className={p.row}><ThemeButton /><Button onClick={() => dirty ? setPending("exit") : onExit()}>実ログインに戻る</Button></div></div></Card>
    <Notice intent="warning">架空の工事データです。ログインしていません。本番API・DBには接続せず、入力と概算の確認のみできます。登録・保存はできず、再読込や終了で入力は消えます。</Notice>
    <nav className={p.row} aria-label="サンプルの機能"><Button appearance={tab === "cockpit" ? "primary" : "secondary"} onClick={() => setTab("cockpit")}>工事の状況</Button><Button appearance={tab === "input" ? "primary" : "secondary"} onClick={() => setTab("input")}>入力を試す</Button></nav>
    <section hidden={tab !== "cockpit"}><CockpitView projects={sampleProjects} selection={selection} onSelect={choose} onRegister={() => setTab("input")} /></section>
    <section hidden={tab !== "input"}><EasyCostInput key={version} previewOnly projects={sampleProjects} companyCode="0000" selection={selection} onSelect={choose} lookups={sampleLookups} lookupsLoading={false} lookupsError={null} onRetryLookups={async () => {}} onRegistered={async () => false} onDirtyChange={setDirty} onBusyChange={() => {}} onShowCockpit={() => setTab("cockpit")} /></section>
    <ConfirmDialog open={pending !== null} title="サンプルの入力を破棄しますか？" action="破棄して進む" onCancel={() => setPending(null)} onConfirm={() => { setDirty(false); if (pending === "exit") onExit(); else if (pending) { setSelection(pending); setVersion(v => v + 1); } setPending(null); }}>サンプルの入力は保存されません。この操作では入力途中の内容を破棄します。</ConfirmDialog>
  </main>;
}
