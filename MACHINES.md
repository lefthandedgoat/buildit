# Machine setup notes (buildit honesty depends on these)

Estimates and audits are only as honest as the numbers behind them.
One section per machine; no datasheet fantasies — every number states
its provenance (stopwatch, controller readout, or marked TBD).

## Shapeoko (primary, calibrated)

- Frame: Shapeoko. Spindle: 2.2kW VFD. Units: metric (G21).
- CAM: Carbide Create Pro build 853 (licensed).
- buildit profile `--machine shapeoko`: A400 R5000.
  Provenance: accel model matches stopwatch at ~×1.39 on 3D finish
  files (CC's naive distance/feed under-reads the same cuts).
- Bits on hand: 1" surfacer, 1/4" flat upcut, 1/4" ball, 1/8"
  compression, 1/16" flat, 0.5mm tapered ball nose (~5.1°/side —
  the wedge-fit + detail bit).
- Stock for current work: walnut blank 6" × 5"; locust inlay;
  blue epoxy only.

## Nymo Labs 6040 (TBD — needs numbers before it earns a preset)

- Status: known to exist, nothing measured yet.
- Needed: controller type + sender, `$$` dump (`$110`/`$111`/`$112`
  max rates, `$120`/`$121`/`$122` accels), then one timed cut to
  confirm the estimate ratio the way the Shapeoko's ×1.39 was earned.
- Until then: default `--machine` stays `shapeoko`, and 6040 jobs
  get explicit `--accel`/`--rapid` from the controller readout
  (conservative first: lowest axis values).
- Open: which machine is primary for the Squonk inlay series.
