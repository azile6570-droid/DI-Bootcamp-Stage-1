const express = require('express');
const app = express();
const PORT = 3000;

// Parse incoming JSON request bodies
app.use(express.json());

// Import Routers
const indexRouter = require('./routes/index');
const todosRouter = require('./routes/todos');
const booksRouter = require('./routes/books');

// Mount Routers
app.use('/', indexRouter);
app.use('/todos', todosRouter);
app.use('/books', booksRouter);

// Start Server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
