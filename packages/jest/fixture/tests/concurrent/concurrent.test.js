const { add } = require('../../src/math.js')

// Two overlapping tests: the environment must refuse the second window instead of
// charging one test's coverage to the other.
test.concurrent('concurrent one', async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(add(1, 2)).toBe(3)
})

test.concurrent('concurrent two', async () => {
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(add(2, 2)).toBe(4)
})
