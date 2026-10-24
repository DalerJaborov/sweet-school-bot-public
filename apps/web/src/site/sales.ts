/** Only official WhatsApp endpoints are accepted from the public catalogue. */
export function whatsappOrderUrl(contact: string, text: string): string {
  const fallback = "https://api.whatsapp.com/send?phone=992905355355";
  let url: URL;
  try {
    url = new URL(contact);
    if (url.protocol !== "https:" || !["api.whatsapp.com", "wa.me"].includes(url.hostname)) throw new Error("contact");
    const digits = url.hostname === "wa.me" ? url.pathname.slice(1) : (url.searchParams.get("phone") ?? "");
    if (!/^\d{9,15}$/.test(digits)) throw new Error("phone");
    url = new URL(`https://api.whatsapp.com/send?phone=${digits}`);
  } catch {
    url = new URL(fallback);
  }
  url.searchParams.set("text", text);
  return url.href;
}
