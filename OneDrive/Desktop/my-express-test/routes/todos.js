const express = require('express');
const router = express.Router();

let todos = [
  { id: 1, task: 'Learn Express.js', completed: false },
  { id: 2, task: 'Build a To-Do API', completed: false }
];

router.get('/', (req, res) => {
  res.json(todos);
});

router.post('/', (req, res) => {
  const { task } = req.body;
  if (!task) {
    return res.status(400).json({ error: 'Task content is required' });
  }

  const newTodo = {
    id: todos.length ? todos[todos.length - 1].id + 1 : 1,
    task,
    completed: false
  };

  todos.push(newTodo);
  res.status(201).json(newTodo);
});

router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { task, completed } = req.body;

  const todo = todos.find((t) => t.id === parseInt(id));
  if (!todo) {
    return res.status(404).json({ error: 'To-Do item not found' });
  }

  if (task !== undefined) todo.task = task;
  if (completed !== undefined) todo.completed = completed;

  res.json(todo);
});

router.delete('/:id', (req, res) => {
  const { id } = req.params;
  const index = todos.findIndex((t) => t.id === parseInt(id));

  if (index === -1) {
    return res.status(404).json({ error: 'To-Do item not found' });
  }

  const deletedTodo = todos.splice(index, 1);
  res.json({ message: 'To-Do item deleted', todo: deletedTodo[0] });
});

module.exports = router;
