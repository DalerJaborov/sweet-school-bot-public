import { useEffect, useState } from "react";

/** Есть ли сеть — по событиям браузера. `navigator.onLine` врёт в сторону
 *  «есть» (Wi-Fi без интернета), поэтому сетевые ошибки обрабатываются отдельно. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}
