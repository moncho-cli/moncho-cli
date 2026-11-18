# make sure JSON responses from commands are pretty printed

status: done

## Steps

- [ ] (no steps recorded)

## Notes

- app/json-display.js: looksLikeJson/prettyPrintJson/payloadOf/formatCommandResult (display-only, null and broken payloads returned unchanged)
- main.js formats tool results (prettyPrintJson) and command results (formatCommandResult) before printing
- app/commands.js /sessions now returns its listing as data instead of printing
- docs/interface/json-display/{behaviour.md,spec.yaml} registered in docs/index.yaml
- tests/json-display.test.js (6 cases); full suite 155/155 green
