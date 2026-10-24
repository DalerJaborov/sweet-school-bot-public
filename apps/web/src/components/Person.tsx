import { Icons } from "./Brand";

/**
 * Человек в списке: лицо, имя и откуда он пришёл.
 *
 * Раньше во всех разделах светился голый идентификатор — по нему невозможно
 * узнать клиента и приходилось искать по переписке. Теперь одинаково во всех
 * списках: аватар (настоящий, если Instagram его отдал, иначе кружок с буквой),
 * имя или ник, и значок канала — Instagram, Messenger или комментарий.
 */

export type PersonLike = {
  igUserId: string;
  username?: string | null;
  name?: string | null;
  avatarUrl?: string | null;
  channel?: string | null;
};

/** Пастельные кружки-заглушки — та же палитра, что у иконок (teal/orange/pink/
 *  dark), а не яркие насыщенные цвета: у одного человека тон не меняется от
 *  списка к списку, а сам цвет остаётся в языке остального интерфейса. */
const AVATAR_TONES = ["teal", "orange", "pink", "dark"] as const;

function toneFor(id: string): (typeof AVATAR_TONES)[number] {
  let sum = 0;
  for (let i = 0; i < id.length; i += 1) sum += id.charCodeAt(i);
  return AVATAR_TONES[sum % AVATAR_TONES.length];
}

/** Что показать буквой, когда фото нет. */
function initial(p: PersonLike): string {
  const source = (p.name ?? p.username ?? "").trim();
  return source ? source[0].toUpperCase() : "?";
}

/** Как назвать человека: имя → ник → короткий хвост идентификатора. */
export function personTitle(p: PersonLike): string {
  if (p.name) return p.name;
  if (p.username) return `@${p.username}`;
  return p.igUserId.length > 8 ? `ID ···${p.igUserId.slice(-6)}` : `ID ${p.igUserId}`;
}

/** Подпись под именем: ник, если он есть и уже не занял место имени. */
export function personSubtitle(p: PersonLike): string {
  if (p.channel === "MANUAL") return p.igUserId;
  return p.name && p.username ? `@${p.username}` : "";
}

export function Avatar({ person, size = 40 }: { person: PersonLike; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size / 2.4) };
  if (person.avatarUrl) {
    return (
      <img
        className="avatar"
        style={style}
        src={person.avatarUrl}
        alt=""
        loading="lazy"
        // Ссылки CDN Instagram протухают. Битую картинку прячем, чтобы вместо
        // лица не торчал значок «изображение не загрузилось».
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }
  return (
    <span className={`avatar avatar-letter icon-circle ${toneFor(person.igUserId)}`} style={style} aria-hidden>
      {initial(person)}
    </span>
  );
}

/** Значок канала — сразу видно, откуда человек пишет. */
export function ChannelMark({ channel }: { channel?: string | null }) {
  if (channel === "MANUAL") return <span className="channel channel-web" title="Ручная продажа">✓</span>;
  // Чат на сайте shirinsweets.online: у такого человека нет ни Instagram, ни
  // Messenger — подписываем словом, чтобы владелец не искал его в директе.
  if (channel === "WEB") {
    return (
      <span className="channel channel-web" title="Чат на сайте">
        Сайт
      </span>
    );
  }
  const messenger = channel === "MESSENGER";
  return (
    <span className={`channel ${messenger ? "channel-fb" : "channel-ig"}`} title={messenger ? "Facebook Messenger" : "Instagram"}>
      {messenger ? Icons.messenger : Icons.instagram}
    </span>
  );
}

/** Готовая строка «аватар + имя + канал» — одинаковая во всех разделах. */
export function Person({ person, note }: { person: PersonLike; note?: string }) {
  const subtitle = personSubtitle(person);
  return (
    <div className="person">
      <Avatar person={person} />
      <div className="person-text">
        <div className="person-name">
          {personTitle(person)}
          <ChannelMark channel={person.channel} />
        </div>
        {(note || subtitle) && <div className="person-note">{note || subtitle}</div>}
      </div>
    </div>
  );
}
