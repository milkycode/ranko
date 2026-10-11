/* @jsxRuntime classic */
/* @jsx h */
/* @jsxFrag Fragment */
import type { ClientModule } from 'claude-code'

/**
 * A button for the desktop band: a label on a fill, one row high, that posts
 * once the pointer comes up on it.
 *
 * The desktop draws the band again for every frame of Ranko, ten times a
 * second, and a Button drawn anew between press and release loses the
 * click. A Client is kept across those redraws and gets the pointer whole,
 * so the band's buttons there are this.
 */

export type PressProps = {
  label: string
  isPrimary: boolean
}

/** What a press posts: the hooks module acts on the element's key. */
export type PressMessage = { isPressed: true }

const Press: ClientModule<PressProps, boolean> = (props, surface) => {
  const { Box, Text } = surface.elements

  surface.onPointer(event => {
    if (event.type === 'down') {
      surface.setState(true)
    } else if (event.type === 'up' && surface.state === true) {
      surface.setState(false)
      // Let go off the button, it is no press; before its first layout its
      // size is not known, and the release counts.
      const isLaidOut = surface.columns > 0 && surface.rows > 0
      if (!isLaidOut || (event.x >= 0 && event.x < surface.columns && event.y >= 0 && event.y < surface.rows)) {
        const message: PressMessage = { isPressed: true }
        surface.post(message)
      }
    }
  })

  // One row, a fill rather than a frame: a frame takes a row above and below.
  return (
    <Box backgroundColor={props.isPrimary ? 'claude' : 'promptBorder'} paddingX={1}>
      <Text color={props.isPrimary ? 'inverseText' : 'text'} bold={props.isPrimary} inverse={surface.state === true}>
        {props.label}
      </Text>
    </Box>
  )
}

export default Press
