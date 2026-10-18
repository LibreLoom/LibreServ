import { Link } from "react-router-dom";
import Card from "@libreloom/ui/components/cards/Card.jsx";
import Button from "@libreloom/ui/components/ui/Button.jsx";
import { sharedItemAction, sharedItemHref } from "../../lib/access.js";

/** The dashboard lists only the first few; the gallery holds the full list. */
const MAX_ALBUMS = 8;

/**
 * Albums other people shared with a Member. Each row shows the album name and a button that
 * opens it in the gallery. When there are more than eight, a "See all albums" button leads to
 * the gallery's album list. Renders nothing when there are no albums.
 *
 * The card is a surface-secondary panel, so the names are primary-colored and the buttons use
 * their default (card) surface.
 *
 * @param {{
 *   albums?: Array<{ id: string, name: string, kind: string, drive_id: string, album_id: string }>,
 * }} props
 */
export default function SharedAlbumsCard({ albums }) {
  if (!Array.isArray(albums) || albums.length === 0) return null;

  return (
    <Card title="Albums shared with you">
      <ul className="space-y-3">
        {albums.slice(0, MAX_ALBUMS).map((album) => (
          <li key={album.id} className="flex items-center justify-between gap-3">
            <span className="text-primary text-sm">{album.name}</span>
            <Button size="sm" variant="primary" asChild>
              <Link to={sharedItemHref(album)}>{sharedItemAction(album)}</Link>
            </Button>
          </li>
        ))}
      </ul>
      {albums.length > MAX_ALBUMS ? (
        <div className="mt-3">
          <Button size="sm" variant="outline" asChild>
            <Link to="/gallery#albums">See all albums</Link>
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
