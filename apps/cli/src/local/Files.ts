/**
 * Writing a file whole, so a reader never sees half of it: the text goes to a
 * temporary file next to it, which is renamed into place.
 *
 * Each write has a temporary file of its own. Processes that write the same
 * file at once (the two task-start hooks of a hand-over in two parts both
 * record the repo's new path) would otherwise share one: the first rename
 * takes it, and the second fails. Windows can also refuse a rename for a
 * moment while another process holds the file, so a failed rename is tried
 * again a few times before the write fails. The last write wins.
 */
import { Effect, FileSystem, Schedule } from "effect"

let writes = 0

export const writeFileWhole = (fs: FileSystem.FileSystem, file: string, text: string) => {
  const tmp = `${file}.${process.pid}-${++writes}.tmp`
  return fs.writeFileString(tmp, text).pipe(
    Effect.andThen(fs.rename(tmp, file).pipe(Effect.retry({ times: 5, schedule: Schedule.spaced("20 millis") }))),
    Effect.onError(() => fs.remove(tmp).pipe(Effect.ignore))
  )
}
