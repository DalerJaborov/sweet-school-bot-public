import { useEffect, useState } from "react";
import { formatTime, type Dict } from "../i18n";
import { RATES, type Rate } from "./prefs";
import type { QualityLevel } from "./useHls";

/**
 * СВОИ КНОПКИ ПЛЕЕРА вместо нативных: нативные на Android мелкие, на iOS
 * уводят видео в системный полноэкран без водяного знака, и ни там, ни там
 * нет «−10/+10» — а именно назад на десять секунд мотают чаще всего («что она
 * сейчас добавила?»). Все цели — 48px, подписи — из словаря.
 *
 * СКОРОСТЬ И КАЧЕСТВО — МАЛЕНЬКИЕ МЕНЮ, а не перебор по кругу (03.09.2026):
 * с пятью скоростями «дощёлкать» до нужной — четыре нажатия, и каждое дёргает
 * видео. Меню показывает все варианты сразу, выбранный отмечен `aria-pressed`.
 * В подписи «Авто · 720p» — какую дорожку ABR играет сейчас, чтобы человек
 * видел, что качество и правда подстраивается, и не лез в ручной режим зря.
 *
 * ПОДСКАЗКА ВРЕМЕНИ ПРИ ПЕРЕМОТКЕ: пока ползунок тянут, над ним висит время —
 * без этого на длинном уроке попасть в нужную минуту пальцем невозможно.
 */
export type ControlsProps = {
  t: Dict;
  playing: boolean;
  current: number;
  duration: number;
  buffered: number;
  rate: Rate;
  levels: QualityLevel[];
  /** Ручной выбор, −1 — авто. */
  level: number;
  /** Что играет ABR сейчас (индекс), −1 — неизвестно. */
  autoLevel: number;
  showQuality: boolean;
  fullscreen: boolean;
  onPlayPause: () => void;
  onSeek: (sec: number) => void;
  onSkip: (delta: number) => void;
  onRate: (rate: Rate) => void;
  onLevel: (index: number) => void;
  onFullscreen: () => void;
  /** Любое касание кнопок — продлить показ. */
  onPoke: () => void;
};

type Menu = "rate" | "quality" | null;

export function Controls(p: ControlsProps) {
  const { t } = p;
  const [menu, setMenu] = useState<Menu>(null);
  const [dragging, setDragging] = useState(false);

  const dur = Number.isFinite(p.duration) && p.duration > 0 ? p.duration : 0;
  const bufferedPct = dur ? Math.min(100, (p.buffered / dur) * 100) : 0;
  const playedPct = dur ? Math.min(100, (p.current / dur) * 100) : 0;

  // Качество по возрастанию — так список читается как «хуже → лучше».
  const sorted = [...p.levels].sort((a, b) => a.height - b.height);
  const heightOf = (index: number) => p.levels[index]?.height;
  const qualityLabel =
    p.level < 0
      ? heightOf(p.autoLevel)
        ? t.qualityAutoWith(`${heightOf(p.autoLevel)}p`)
        : t.qualityAuto
      : `${heightOf(p.level) ?? ""}p`;

  // Кнопки спрятались (пауза меню не нужна) или сменился урок — меню закрыть.
  useEffect(() => {
    if (!p.playing) return;
    const id = window.setTimeout(() => setMenu(null), 4000);
    return () => window.clearTimeout(id);
  }, [p.playing, menu]);

  const toggleMenu = (m: Exclude<Menu, null>) => {
    setMenu((cur) => (cur === m ? null : m));
    p.onPoke();
  };

  return (
    <div className="player-controls" onPointerDown={p.onPoke}>
      {menu === "rate" && (
        <div className="pc-menu" role="group" aria-label={t.speed}>
          {RATES.map((r) => (
            <button
              key={r}
              type="button"
              className="pc-menu-item"
              aria-pressed={r === p.rate}
              onClick={() => {
                p.onRate(r);
                setMenu(null);
              }}
            >
              {r}×
            </button>
          ))}
        </div>
      )}
      {menu === "quality" && (
        <div className="pc-menu" role="group" aria-label={t.quality}>
          <button
            type="button"
            className="pc-menu-item"
            aria-pressed={p.level < 0}
            onClick={() => {
              p.onLevel(-1);
              setMenu(null);
            }}
          >
            {t.qualityAuto}
          </button>
          {sorted.map((l) => (
            <button
              key={l.index}
              type="button"
              className="pc-menu-item"
              aria-pressed={l.index === p.level}
              onClick={() => {
                p.onLevel(l.index);
                setMenu(null);
              }}
            >
              {l.height}p
            </button>
          ))}
        </div>
      )}

      <div className="pc-seek">
        <div className="pc-track" aria-hidden="true">
          <div className="pc-buffered" style={{ width: `${bufferedPct}%` }} />
          <div className="pc-played" style={{ width: `${playedPct}%` }} />
        </div>
        {dragging && (
          <div className="pc-preview" style={{ left: `${playedPct}%` }} aria-hidden="true">
            {formatTime(p.current)}
          </div>
        )}
        <input
          type="range"
          className="pc-range"
          min={0}
          max={dur || 1}
          step={1}
          value={Math.min(p.current, dur || 1)}
          aria-label={t.seek}
          aria-valuetext={t.seekValue(formatTime(p.current), formatTime(dur))}
          onChange={(e) => p.onSeek(Number(e.target.value))}
          onPointerDown={() => setDragging(true)}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onBlur={() => setDragging(false)}
        />
      </div>

      <div className="pc-row">
        <button type="button" className="pc-btn" onClick={() => p.onSkip(-10)} aria-label={t.rewind}>
          <SkipGlyph back />
        </button>
        <button
          type="button"
          className="pc-btn"
          onClick={p.onPlayPause}
          aria-label={p.playing ? t.pauseVideo : t.playVideo}
        >
          {p.playing ? <PauseGlyph /> : <PlayGlyph />}
        </button>
        <button type="button" className="pc-btn" onClick={() => p.onSkip(10)} aria-label={t.forward}>
          <SkipGlyph />
        </button>

        <span className="pc-time" aria-hidden="true">
          {formatTime(p.current)} / {formatTime(dur)}
        </span>

        <span className="pc-spacer" />

        <button
          type="button"
          className="pc-btn pc-text"
          onClick={() => toggleMenu("rate")}
          aria-label={`${t.speed}: ${p.rate}×`}
          aria-expanded={menu === "rate"}
        >
          {p.rate}×
        </button>
        {p.showQuality && sorted.length > 1 && (
          <button
            type="button"
            className="pc-btn pc-text"
            onClick={() => toggleMenu("quality")}
            aria-label={`${t.quality}: ${qualityLabel}`}
            aria-expanded={menu === "quality"}
          >
            {qualityLabel}
          </button>
        )}
        <button
          type="button"
          className="pc-btn"
          onClick={p.onFullscreen}
          aria-label={p.fullscreen ? t.exitFullscreen : t.fullscreen}
        >
          <FullscreenGlyph exit={p.fullscreen} />
        </button>
      </div>
    </div>
  );
}

function PlayGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
      <path d="M6 3v16l13-8z" fill="currentColor" />
    </svg>
  );
}
function PauseGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
      <path d="M5 3h4v16H5zM13 3h4v16h-4z" fill="currentColor" />
    </svg>
  );
}
function SkipGlyph({ back = false }: { back?: boolean }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 22 22"
      aria-hidden="true"
      focusable="false"
      style={back ? { transform: "scaleX(-1)" } : undefined}
    >
      <path d="M11 3a8 8 0 1 0 8 8h-2a6 6 0 1 1-6-6v3l4-4-4-4z" fill="currentColor" />
      <text
        x="8"
        y="14.5"
        fontSize="7"
        fontWeight="700"
        fill="currentColor"
        style={back ? { transform: "scaleX(-1)", transformOrigin: "11px 11px" } : undefined}
      >
        10
      </text>
    </svg>
  );
}
function FullscreenGlyph({ exit }: { exit: boolean }) {
  return exit ? (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
      <path d="M8 3v5H3M14 3v5h5M8 19v-5H3M14 19v-5h5" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  ) : (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" focusable="false">
      <path d="M3 8V3h5M19 8V3h-5M3 14v5h5M19 14v5h-5" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
