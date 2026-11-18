beauty ui changes
status: done

- [x] keep the context usage information always visible by aligningn it to the right of the row
- [x] the output of the tool calls most of the times should be collapsed by default, the user would click to expand and see then click again to collapse, so by default just says inline at the end "X char response"
- [x] under the ignored agent/ path create sessions/ where we will store date named files with the full context of the conversations, properly formatted to be able to be picked up
- [x] by adding a command /sessions we could open a modal to select previous sessions and continue working on those (the commands should be iterable code so we can add more commands later)
- [x] make sure JSON responses from commands are pretty printed