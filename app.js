var createError = require('http-errors');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var cors = require('cors');
require('dotenv').config();

var indexRouter = require('./routes/index');
var getRouter = require('./routes/get');
var v1Router = require('./routes/v1');
var indexer = require('./indexer');

var app = express();
app.use(cors({ exposedHeaders: ['X-Pending'] }));

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
// this disables serving everything from the public directory
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/get', getRouter);
// Mounted after indexRouter so the existing /v1/metadata/* route keeps
// precedence; only /v1/state, /v1/stream and /v1/status land here.
app.use('/v1', v1Router);

// Opt-in only. Without INDEXER=true this is a no-op and the server behaves
// exactly as it did before.
if (indexer.isEnabled()) {
  indexer
    .get()
    .start()
    .then((s) =>
      console.log(
        `[indexer] ready: ${s.vipers} vipers, ${s.bites} bites, ${s.logs} logs at block ${s.block}`
      )
    )
    .catch((e) => console.error('[indexer] failed to start:', e));
}

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  next(createError(404));
});

// error handler
app.use(function (err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
