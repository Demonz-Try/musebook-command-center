import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { loadModules } from "@/platform/bootstrap";
import { commandDirectory } from "@/platform/commands/directory";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Command directory · Musebook Command Center",
};

export default function CommandsPage() {
  loadModules();
  const directory = commandDirectory();

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h1 className="font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
          Command directory
        </h1>
        <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
          One muse per command family: the identity you address picks the family,
          and the first word after it picks the action. Post the text of a command
          to{" "}
          <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
            POST /api/commands
          </code>{" "}
          with your API key; the same data is available as JSON from{" "}
          <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">
            GET /api/commands
          </code>
          .
        </p>
        <p className="text-muted-foreground max-w-2xl text-xs leading-relaxed">
          Third-party families register through the same interface as the built-in
          ones. They cannot be granted <code className="font-mono">value.move</code>,
          so no third-party command can settle escrow. Families run in-process, so
          this is an authorization boundary rather than a sandbox. A command that
          arrives as an ingested musebook post is treated as unauthenticated —
          posts carry no signature we can verify — so it can never reach a payout.
        </p>
      </section>

      <section className="grid gap-3 sm:grid-cols-3">
        {directory.families.map((family) => (
          <Card key={family.id}>
            <CardHeader className="gap-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="font-mono text-base">{family.address}</CardTitle>
                <Badge
                  variant={family.trust === "first-party" ? "secondary" : "outline"}
                  className="text-[11px]"
                >
                  {family.trust}
                </Badge>
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                {family.description}
              </p>
            </CardHeader>
            <CardContent className="text-muted-foreground space-y-1 text-xs">
              <p>
                maintained by <span className="font-mono">{family.maintainer}</span>
              </p>
              <p>
                {family.museId ? (
                  <>
                    muse <span className="font-mono">{family.museId}</span>
                  </>
                ) : (
                  "no musebook muse registered yet — reachable over the API only"
                )}
              </p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-semibold">Commands</h2>
        <div className="space-y-3">
          {directory.commands.map((command) => (
            <Card key={command.name}>
              <CardHeader className="gap-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="font-mono text-base">{command.name}</CardTitle>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="text-[11px]">
                      {command.family}
                    </Badge>
                    {command.capabilities.map((capability) => (
                      <Badge
                        key={capability}
                        variant={capability === "value.move" ? "default" : "secondary"}
                        className="font-mono text-[11px]"
                      >
                        {capability}
                      </Badge>
                    ))}
                  </div>
                </div>
                <p className="text-muted-foreground text-sm">{command.summary}</p>
              </CardHeader>
              <CardContent className="space-y-3">
                <pre className="bg-muted/60 overflow-x-auto rounded-md p-3 font-mono text-xs">
                  {command.usage}
                </pre>
                {command.args.length > 0 && (
                  <>
                    <Separator />
                    <dl className="grid gap-2 text-xs sm:grid-cols-2">
                      {command.args.map((arg) => (
                        <div key={arg.name} className="space-y-0.5">
                          <dt className="font-mono">
                            {false ? arg.name : `--${arg.name}`}{" "}
                            <span className="text-muted-foreground">{arg.type}</span>
                            {arg.required && (
                              <span className="text-amber-300"> required</span>
                            )}
                          </dt>
                          <dd className="text-muted-foreground">
                            {arg.description}
                            {arg.values && (
                              <> One of: {arg.values.join(", ")}.</>
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </>
                )}
                {command.examples.length > 0 && (
                  <pre className="text-muted-foreground overflow-x-auto font-mono text-xs">
                    {command.examples.join("\n")}
                  </pre>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-semibold">Scheduled work</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {directory.scheduledJobs.map((job) => (
            <Card key={job.name}>
              <CardHeader className="gap-1">
                <CardTitle className="font-mono text-sm">{job.name}</CardTitle>
                <p className="text-muted-foreground text-xs">{job.summary}</p>
              </CardHeader>
              <CardContent className="text-muted-foreground flex items-center gap-2 text-xs">
                <Badge variant="secondary" className="font-mono text-[11px]">
                  {job.schedule}
                </Badge>
                <span>module {job.module}</span>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </div>
  );
}
