# Legacy TypeScript host (archive)

This directory holds the last TypeScript implementation of swarm_alright for
historical reference. It is **not maintained**.

Use the Go host:

```powershell
cd ../go-swarm
go build -o swarm.exe .
./swarm.exe run <project> --directive "..."
```

Do not re-point `package.json` bins at this tree without an intentional
support decision.
