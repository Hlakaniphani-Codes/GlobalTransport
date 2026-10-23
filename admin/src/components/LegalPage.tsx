import ReactMarkdown from 'react-markdown';
import { Link } from 'react-router-dom';

type LegalPageProps = {
  title: string;
  content: string;
};

export function LegalPage({ title, content }: LegalPageProps) {
  const supportEmail = import.meta.env.VITE_SUPPORT_EMAIL?.trim();
  return (
    <main className="public-page">
      <article className="public-panel legal-panel">
        <Link className="legal-back" to="/">Global Ride Transport</Link>
        <ReactMarkdown>{content}</ReactMarkdown>
        {supportEmail && (
          <p className="legal-contact">
            Contact: <a href={`mailto:${encodeURIComponent(supportEmail)}`}>{supportEmail}</a>
          </p>
        )}
        <nav aria-label="Legal pages" className="legal-navigation">
          <Link to="/privacy" aria-current={title === 'Privacy policy' ? 'page' : undefined}>Privacy policy</Link>
          <Link to="/terms" aria-current={title === 'Terms of service' ? 'page' : undefined}>Terms of service</Link>
        </nav>
      </article>
    </main>
  );
}
