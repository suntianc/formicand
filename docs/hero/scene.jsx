import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import HarnessCorner from "./HarnessCorner.jsx";
import Mark from "./Mark.jsx";
import "./scene.css";

const params = new URLSearchParams(location.search);
const recording = params.has("time") || params.has("capture");
// Frozen moment for the static PNG: the largest node's ring is half way out.
const STILL_TIME = 0.9;

function Hero() {
  const [time, setTime] = useState(Number(params.get("time")) || 0);
  const [still, setStill] = useState(
    params.has("static") || (!recording && matchMedia("(prefers-reduced-motion: reduce)").matches)
  );
  useEffect(() => {
    window.renderHeroFrame = (value) => flushSync(() => setTime(value));
    document.documentElement.dataset.captureReady = "true";
    if (recording || still) return;
    let frame;
    const start = performance.now();
    const tick = (now) => {
      setTime(((now - start) / 1000) % 6);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [still]);
  return (
    <>
      <main className="hero" aria-label="Formicand">
        <svg viewBox="0 0 1440 480" role="img" aria-labelledby="hero-title">
          <title id="hero-title">Formicand — five-node mark, wordmark and desktop workspace</title>
          <defs>
            <radialGradient id="ambient">
              <stop stopColor="#ffffff" stopOpacity=".07" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
            </radialGradient>
            <pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse">
              <circle cx="12" cy="12" r=".75" fill="#ffffff" opacity=".07" />
            </pattern>
            <linearGradient id="bottom-fade" x2="0" y2="1">
              <stop offset="0" stopColor="#09090a" stopOpacity="0" />
              <stop offset="1" stopColor="#09090a" stopOpacity=".55" />
            </linearGradient>
            <filter id="window-shadow" x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="16" stdDeviation="22" floodOpacity=".6" />
            </filter>
          </defs>
          <path fill="#09090a" d="M0 0H1440V480H0z" />
          <path fill="url(#dots)" d="M0 0H1440V480H0z" />
          <ellipse cx="190" cy="240" rx="260" ry="220" fill="url(#ambient)" />
          <HarnessCorner x={1124} y={128} />
          <Mark x={58} y={110} size={260} time={still ? STILL_TIME : time} />
          <text x="352" y="291" fontSize="138" fontWeight="700" letterSpacing="-5" fill="#f5f5f7">
            Formicand
          </text>
          <path d="M1124 430H1440V480H1124z" fill="url(#bottom-fade)" pointerEvents="none" />
        </svg>
      </main>
      {!recording && (
        <footer>
          <button onClick={() => setStill(!still)}>{still ? "Play animation" : "Static preview"}</button>
          <span>1440 × 480 · 6s loop</span>
        </footer>
      )}
    </>
  );
}
createRoot(document.getElementById("root")).render(<Hero />);
