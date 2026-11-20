# todo-cli

A small to-do list kept in a JSON file (`todo.json`, or the path in `TODO_FILE`).

```sh
node src/cli.js add "Buy milk" --tag home
node src/cli.js list [--page N] [--size N] [--sort id|title]
node src/cli.js done 1
node src/cli.js search milk
node src/cli.js export
```

Run the tests with `npm test`.
