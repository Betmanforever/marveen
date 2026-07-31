# systemd unit files

Host timers for the fleet's agent-INDEPENDENT controls. A control that lives
inside an agent's turn cycle is unreachable exactly when that agent is the
fault, so these run as `systemd --user` units instead.

Historically the units existed only in `~/.config/systemd/user/` and nowhere in
the repo, which made them unreviewable and unrecoverable. New units are tracked
here and copied to `~/.config/systemd/user/` at install time.

## Installing a unit

    cp systemd/<name>.{service,timer} ~/.config/systemd/user/
    systemctl --user daemon-reload
    systemctl --user enable --now <name>.timer

Enabling is deliberately a separate, manual, operator step: adding a timer adds
an autonomous emitter, and the 2026-07-31 alerting audit is the record of what
happens when those accumulate unreviewed.

## Current

- `marveen-model-ledger-reconcile` -- daily reconciliation of model switches
  against `config_change_log` (audit AC-10). Silent by default, findings go to
  the coordinator, never to the owner. **Installed but NOT enabled**: turning it
  on is the operator's call.
