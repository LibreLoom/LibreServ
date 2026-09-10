/* eslint-disable react-refresh/only-export-components -- VIEWER_BY_KIND shared with tests */
import PropTypes from "prop-types";
import PdfViewer, { AudioViewer } from "./PdfAudioViewers.jsx";
import ArchiveViewer, { ComicViewer } from "./ArchiveComicViewers.jsx";
import EbookViewer, { FontViewer } from "./EbookFontViewers.jsx";
import NotebookViewer, {
  CalendarViewer,
  ContactViewer,
  CadDownloadMessage,
  GeoViewer,
} from "./DocumentMetaViewers.jsx";
import OfficeEditor from "../office/OfficeEditor.jsx";

/**
 * Kind → viewer component. Image / video / text stay inline in FileViewer
 * (they own full-view / save chrome). Everything else mounts from here.
 */
export const VIEWER_BY_KIND = {
  pdf: PdfViewer,
  audio: AudioViewer,
  archive: ArchiveViewer,
  comic: ComicViewer,
  ebook: EbookViewer,
  font: FontViewer,
  notebook: NotebookViewer,
  geo: GeoViewer,
  calendar: CalendarViewer,
  contact: ContactViewer,
  cad: CadDownloadMessage,
  office: OfficeEditor,
};

/**
 * @param {{
 *   kind: string | null,
 *   driveId: string,
 *   path: string,
 *   canWrite?: boolean,
 *   onSaved?: () => void,
 * }} props
 */
export default function KindViewer({ kind, driveId, path, canWrite = true, onSaved }) {
  const Viewer = kind ? VIEWER_BY_KIND[kind] : null;
  if (!Viewer) return null;
  return (
    <Viewer
      driveId={driveId}
      path={path}
      canWrite={canWrite}
      onSaved={onSaved}
    />
  );
}

KindViewer.propTypes = {
  kind: PropTypes.string,
  driveId: PropTypes.string.isRequired,
  path: PropTypes.string.isRequired,
  canWrite: PropTypes.bool,
  onSaved: PropTypes.func,
};
