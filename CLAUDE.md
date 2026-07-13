# baseaichat

## Projektkontext

Wiederverwendbare Chat-Komponente (Go-Backend + React-Frontend), die in andere Apps
eingebettet wird — u. a. perspektivisch in FieldDraft.

Das Besondere: Der Agent-Loop läuft **im Browser**. Das Modell schreibt JavaScript gegen
eine App-API (`evaluate`-Pattern) und kann die UI lesen und bedienen. Der Go-Teil ist ein
Proxy, der den API-Key hält und die Leitplanken setzt (Model-Allowlist, Rate-Limit, Auth-Hook).

Architektur, Sicherheitsmodell und Integrationsanleitung stehen in `README.md`.

## Aufbau

- `server/` — Go, Package `aichat`. Einbettbar via `aichat.NewProxy(Config)`, plus
  Standalone-Binary unter `cmd/aichat-proxy`.
- `web/` — TS/React-Lib `baseaichat`. Wird als **Source** konsumiert (Vite-Alias oder
  Install), nicht als gebautes Bundle.
- `example/` — Sprint-Board-Demo auf Port 5180, Vite proxyt `/aichat` → `:8090`.

## Kritische Stellen

- **Das API-Objekt ist die Sicherheitsgrenze**, nicht der Guard. Der Guard
  (`web/src/core/guard.ts`) hindert den Code am Ausbruch *aus* der API; was die API darf,
  entscheidet die App. Er ist blocklist-basiert (Escapes, Globale, Prototype-Chain) und
  scope-bewusst: `const open = …` ist eine lokale Variable, nur die *freie* Referenz auf
  `open` ist der Globale. Bewusst keine Allowlist — die bräuchte die API-Keys, und die
  API ist oft ein tiefer, dynamischer Objektbaum. Änderungen hier immer mit
  `guard.test.ts` absichern; die Escape-Tests sind kein Beiwerk.
- `with (api)` ist Ergonomie, keine Sandbox. Eine Blocklist ist unvollständig — jeder
  weitere Ausführungspfad der App (Skriptsprache, Plugin-Eval) führt am Guard vorbei.
- Der ausgeführte Code läuft auf dem Main-Thread. Endlosschleifen frieren den Tab ein
  (der Timeout greift nur bei async). Keine destruktiven Operationen in die API legen,
  die man dem Nutzer nicht auch erlauben würde.

## Kommandos

```bash
cd server && go test -race ./...      # Proxy-Tests
cd web    && npx vitest run           # 53 Unit-Tests (Node 22 via nvm nötig)
cd web    && npx tsc --noEmit         # Typecheck der Lib
cd example && npm run dev             # Demo (Proxy muss auf :8090 laufen)

# End-to-End gegen ein echtes Modell (kostet Cent-Bruchteile, Proxy muss laufen):
cd web && SMOKE=1 npx vitest run src/smoke.test.ts
```

**Node:** Das System-Node ist v18 und zu alt für Vite 7. Vor npm/vitest/vite immer
`source ~/.nvm/nvm.sh && nvm use 22`.

## Arbeitsverzeichnis
/home/sorokan/ClaudeDraft/baseaichat

_MCP-Tools, Verhaltensregeln und die Vertrauens-Policy unter ClaudeDraft-Agenten
liefert der globale System-Prompt (`.system/source/global-claude.md`),
den der Daemon jeder Session automatisch anhaengt._
