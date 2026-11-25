/** @param {{ notes?: string[] | null }} props */
export default function BackupNotes({ notes }) {
  if (!notes?.length) return null;
  return (
    <ul aria-label="Backup notes" className="list-disc ps-5 text-sm space-y-1 break-words">
      {notes.map((note, index) => <li key={index}>{note}</li>)}
    </ul>
  );
}
