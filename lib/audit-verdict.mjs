/**
 * 把整链校验与逐天校验合成一个裁决（core 与 supervisor 共用，避免两套口径）。
 *
 * 每天各自成链之后，跨天相连的旧文件在整链口径下会显示为断链，但逐天口径下是
 * "起点未知但自证"；这里以逐天为准。
 */
export function firstBadDayVerdict (chainVerify, perDay, badDays) {
  const first = badDays.length > 0 ? badDays[0] : undefined
  return {
    ...(chainVerify ?? {}),
    ok: perDay.ok === true,
    sealed: perDay.sealed,
    legacyDays: perDay.days.filter((d) => d.legacyLinked === true).map((d) => d.day),
    brokenAt: first === undefined ? null : { index: (first.brokenAt ?? 1) - 1, reason: first.reason, day: first.day },
  }
}
