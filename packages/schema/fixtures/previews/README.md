# Public preview fixtures

Each fixture contains a gateway-shaped `input` and its canonical `expected`
response. The Go gateway writes `input.previews` as box state, while the browser
parser consumes the full input object.
