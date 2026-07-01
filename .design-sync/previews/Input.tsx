import { Input, Label } from "@nichehuntr/ui";

export function WithLabel() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 320 }}>
      <Label htmlFor="email">Email address</Label>
      <Input id="email" type="email" placeholder="you@example.com" />
    </div>
  );
}

export function States() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 320 }}>
      <Input placeholder="Default input" />
      <Input defaultValue="Filled with a value" />
      <Input placeholder="Disabled input" disabled />
      <Input defaultValue="Invalid value" aria-invalid />
    </div>
  );
}
