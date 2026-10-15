import "./mail.css";

/** One message body. HTML renders ONLY in a `sandbox=""` iframe (`srcDoc`, nothing fetched), as the /admin/mail preview does: the
 *  empty sandbox withholds scripts, forms, popups and same-origin. Text renders as text. Nothing is kept. */
export function MessageBody({ text, html }: { text: string | null; html: string | null }) {
  if (html) return <iframe title="Message body" sandbox="" srcDoc={html} className="gm-frame" />;
  return <pre className="gm-text">{text && text.length > 0 ? text : "(no text)"}</pre>;
}
