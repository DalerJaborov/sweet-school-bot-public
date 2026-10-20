import { useEffect, useState } from "react";

/**
 * Именной водяной знак поверх видео. Дрейфует раз в восемь секунд:
 * неподвижный легко закрыть или обрезать при перезаписи, дрейфующий приходится
 * ловить весь ролик. Лежит внутри обёртки плеера, поэтому остаётся на месте и
 * в полноэкранном режиме (обёртка уходит в полный экран целиком, а не <video>).
 * От читалок скрыт и касаний не перехватывает.
 */
export function Watermark({ text }: { text: string }) {
  const [pos, setPos] = useState({ x: 8, y: 10 });
  useEffect(() => {
    const timer = setInterval(() => setPos({ x: 5 + Math.random() * 70, y: 8 + Math.random() * 76 }), 8000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="player-mark" style={{ left: `${pos.x}%`, top: `${pos.y}%` }} aria-hidden="true">
      {text}
    </div>
  );
}
