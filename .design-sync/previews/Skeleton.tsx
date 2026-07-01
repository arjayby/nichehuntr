import { Skeleton } from "@nichehuntr/ui";

export function Lines() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 320 }}>
      <Skeleton style={{ height: 20, width: "60%" }} />
      <Skeleton style={{ height: 20, width: "100%" }} />
      <Skeleton style={{ height: 20, width: "80%" }} />
    </div>
  );
}

export function Media() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, maxWidth: 320 }}>
      <Skeleton style={{ height: 48, width: 48, borderRadius: 9999, flexShrink: 0 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
        <Skeleton style={{ height: 14, width: "50%" }} />
        <Skeleton style={{ height: 14, width: "75%" }} />
      </div>
    </div>
  );
}
