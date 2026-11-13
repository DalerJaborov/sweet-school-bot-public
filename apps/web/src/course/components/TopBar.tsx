import type { CourseState } from "../hooks/useCourse";
import { useTheme } from "../theme";
import { BackButton } from "../screens/BackButton";
import { LanguageToggle } from "./LanguageToggle";
import { ThemeToggle } from "./ThemeToggle";

/**
 * ШАПКА ВНУТРЕННИХ ЭКРАНОВ: «назад», название, справа тема и язык — как на
 * главной. Раньше на уроке, в списке уроков, чате и инструментах переключателей
 * не было вовсе (замечание владельца 08.11.2026: «шапки нет»).
 */
export function TopBar({ state, title, onBack }: { state: CourseState; title: string; onBack: () => void }) {
  const { theme, toggle } = useTheme();
  return (
    <header className="topbar topbar-full">
      <BackButton t={state.t} onClick={onBack} />
      <h1 className="topbar-title">{title}</h1>
      <div className="page-head-tools">
        <ThemeToggle t={state.t} theme={theme} onToggle={toggle} />
        <LanguageToggle t={state.t} lang={state.lang} onChange={(l) => void state.switchLanguage(l)} />
      </div>
    </header>
  );
}
