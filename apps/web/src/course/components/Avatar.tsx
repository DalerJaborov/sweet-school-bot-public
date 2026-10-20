/**
 * Круг с первой буквой имени над приветствием. Декоративный: имя уже стоит в
 * заголовке, поэтому от читалок скрыт. Без имени — просто акцентный круг,
 * чтобы шапка не «проседала».
 */
export function Avatar({ name }: { name?: string | null }) {
  const letter = name?.trim().charAt(0).toUpperCase() ?? "";
  return (
    <span className="avatar" aria-hidden="true">
      {letter}
    </span>
  );
}
