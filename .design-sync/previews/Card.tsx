import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  CardAction,
  Button,
} from "@nichehuntr/ui";

export function Default() {
  return (
    <Card style={{ maxWidth: 380 }}>
      <CardHeader>
        <CardTitle>Deploy your project</CardTitle>
        <CardDescription>Ship changes to production in a single click.</CardDescription>
        <CardAction>
          <Button size="sm" variant="ghost">Settings</Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <p style={{ margin: 0 }}>
          Your last deployment finished 3 minutes ago. All systems are operational and traffic is being served normally.
        </p>
      </CardContent>
      <CardFooter style={{ gap: 8 }}>
        <Button size="sm">Deploy</Button>
        <Button size="sm" variant="outline">Preview</Button>
      </CardFooter>
    </Card>
  );
}

export function Compact() {
  return (
    <Card size="sm" style={{ maxWidth: 320 }}>
      <CardHeader>
        <CardTitle>Storage used</CardTitle>
        <CardDescription>The sm size uses tighter spacing.</CardDescription>
      </CardHeader>
      <CardContent>
        <p style={{ margin: 0 }}>42.8 GB of 100 GB — plenty of room for new hunts.</p>
      </CardContent>
    </Card>
  );
}
