/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type { ClientModule } from 'claude-code'

/**
 * An invisible region laid over the pet that turns a press-and-drag into
 * band columns for the hooks module, which moves the pet and redraws.
 *
 * The pet's `Image` takes no pointer events and a `Client` can't draw an
 * `Image`, so the grab sits on top of the picture and draws an empty box:
 * no characters, nothing to cover the pixels.
 *
 * On the desktop the region is a strip along the whole band with the pet in
 * it. There a press beside him is let go, and while he is dragged the region
 * draws a frame where he will land: the desktop shows nothing new in the band
 * until the button comes up, but it keeps drawing this region.
 */

export type GrabProps = {
  /** The band column the region's left edge is drawn at. */
  left: number
  columns: number
  rows: number
  /** Where the pet stands in a region wider than him, the desktop's strip. */
  pet?: { left: number; columns: number; isDraggable: boolean }
}

/** What the region posts: the pointer's band column, with the grab's phase. */
export type GrabMessage = { phase: 'down' | 'move' | 'up'; column: number }

/**
 * A press on the pet in the strip: the region columns it started and is at,
 * and his left column when it started, which a redraw may since have moved.
 */
type Held = { from: number; to: number; petLeft: number } | null

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, Math.round(value)))

const Grab: ClientModule<GrabProps, Held> = (props, surface) => {
  const { Box } = surface.elements
  const { pet } = props

  surface.onPointer(event => {
    if (event.type === 'enter' || event.type === 'leave') {
      return
    }
    // A hover move has no button; only a held drag counts.
    if (event.type === 'move' && event.button === undefined) {
      return
    }
    const x = event.fine?.x ?? event.x + 0.5
    if (pet) {
      const held = surface.state ?? null
      if (event.type === 'down') {
        if (x < pet.left || x >= pet.left + pet.columns) {
          return
        }
        surface.setState({ from: x, to: x, petLeft: pet.left })
      } else if (!held) {
        return
      } else {
        surface.setState(event.type === 'up' ? null : { ...held, to: x })
      }
    }
    const message: GrabMessage = { phase: event.type, column: props.left + x }
    surface.post(message)
  })

  // It takes a column of travel to turn a press into a drag, as the hooks
  // module counts it.
  const held = surface.state
  const isDragged = pet !== undefined && pet.isDraggable && held && Math.abs(held.to - held.from) >= 1
  return (
    <Box width={props.columns} height={props.rows}>
      {isDragged ? (
        <Box
          key="landing"
          position="absolute"
          left={clamp(held.petLeft + held.to - held.from, 0, props.columns - pet.columns)}
          top={0}
          width={pet.columns}
          height={props.rows}
          borderStyle="dashed"
          borderColor="#8f7cf7"
        />
      ) : null}
    </Box>
  )
}

export default Grab
