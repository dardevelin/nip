var _ = require('lazy.js');
var extend = require('xtend');
var blessed = require('blessed');
var clipboard = require('copy-paste').noConflict().silent();

var util = require('./util');
var word = require('./word');
var Coordinate = require('./coordinate');

function Editor (opts) {
  var self = this;

  if (!(self instanceof blessed.Node)) { return new Editor(opts); }

  blessed.Box.call(self, extend({
    tags: true,
    wrap: false,

    // Custom
    tabSize: 4,
    pageLines: 10,
    selectStyle: '{blue-bg}'
  }, opts));

  self
    .toggleInsertMode()
    .text('')
    .cursor({x: 0, y: 0})
    .scroll({x: 0, y: 0})
    ._initHandlers();
}
Editor.prototype.__proto__ = blessed.Box.prototype;

Editor.prototype._initHandlers = function () {
  var self = this;

  self.on('keypress', function (ch, key) {
    var direction = {
      left: -1, right: 1,
      up: -1, down: 1,
      pageup: -1, pagedown: 1,
      home: -1, end: 1,
      backspace: -1, 'delete': 1
    }[key.name];
    if (direction) {
      if (key.name === 'backspace' || key.name === 'delete') {
        if (!self.select().text) {
          self
            .startSelection(self.cursor())
            .moveCursorHorizontal(direction, key.ctrl);
        }
        self.delete(); return;
      }

      var prevSelection = self.startSelection();
      if (!key.shift) {
        self.startSelection(null);
      } else if (!prevSelection) {
        self.startSelection(self.cursor());
      }

      if (key.name === 'left' || key.name === 'right') {
        if (!key.shift && prevSelection && Coordinate.linear.cmp(prevSelection, self.cursor()) === direction) {
          self.cursor(prevSelection);
        } else {
          self.moveCursorHorizontal(direction, key.ctrl);
        }
      } else if (key.name === 'up' || key.name === 'down') {
        self.moveCursorVertical(direction, key.ctrl);
      } else if (key.name === 'pageup' || key.name === 'pagedown') {
        self.moveCursorVertical(direction * self.options.pageLines);
      } else if (key.name === 'home') {
        this.cursor({x: 0, y: self.cursor().y});
      } else if (key.name === 'end') {
        this.cursor({x: Infinity, y: self.cursor().y});
      }
    } else if (key.full === 'C-a') {
      self.select(Coordinate.returnsOrigin(), Coordinate.returnsInfinity());
    } else if (key.full === 'C-c' || key.full === 'C-x') {
      var selection = self.select();
      if (selection.text) { clipboard.copy(selection.text); }
      if (key.full === 'C-x') { self.delete(); }
    } else if (key.full === 'C-v') {
      clipboard.paste(function (err, text) {
        if (err) { throw err; }
        self.change(text);
      });
    } else if (key.name === 'insert') {
      self.toggleInsertMode();
    } else if (!key.ctrl && ch) {
      if (ch === '\r') {
        // FIXME: hack
        ch = '\n';
        if (self.data.enterPressed) { return; }
        self.data.enterPressed = true;
        process.nextTick(function () { self.data.enterPressed = false; });
      }
      var overwrite = !self.insertMode() && !self.select().text && !self.data.enterPressed;
      var cursor = self.cursor();
      self.change(ch, cursor, extend(cursor, {x: cursor.x + overwrite}));
    }
  });

  self.on('mouse', function (mouseData) {
    var mouse = Coordinate(mouseData).subtract(self.pos()).add(self.scroll());

    if (mouseData.action === 'wheeldown' || mouseData.action === 'wheelup') {
      if (!mouseData.shift && !self.data.mouseDown) {
        self.startSelection(null);
      } else if (!self.startSelection()) {
        self.startSelection(self.cursor());
      }
      self.moveCursorVertical({
        wheelup: -1,
        wheeldown: 1
      }[mouseData.action] * self.options.pageLines);
    } else {
      if (mouseData.action === 'mousedown') {
        self.data.mouseDown = true;
        self.startSelection(mouse);
      }
      if (self.data.mouseDown) {
        self.cursor(mouse);
      }
      if (mouseData.action === 'mouseup') {
        self.data.mouseDown = false;
        var startSelection = self.startSelection();
        if (startSelection && Coordinate.linear.cmp(startSelection, mouse) === 0) {
          self.startSelection(null);
        }
      }
    }
  });

  self.on('cursor', function (cursor) {
    var scroll = Coordinate.min(self.scroll(), cursor);
    var maxScroll = Coordinate(cursor).subtract(self.size()).add({x: 1, y: 1});
    scroll = Coordinate.max(scroll, maxScroll);

    self.scroll(scroll);
  });

  // Render events
  self.on('lines', function (lines) {
    self.data.maxWidth = Math.max.apply(Math, _(lines).pluck('length').toArray());
    self._editorRender();
  });
  self.on('scroll', function (scroll) { self._editorRender(); });
  self.on('startSelection', function (selection) { self._editorRender(); });

  return self;
};

Editor._lineRegExp = /\r\n|\r|\n/;
Editor._splitLines = function (text) {
  var lines = [];
  var match, line;
  while (match = Editor._lineRegExp.exec(text)) {
    line = text.slice(0, match.index) + match[0];
    text = text.slice(line.length);
    lines.push(line);
  }
  lines.push(text);
  return lines;
};
Editor.prototype.lines = util.getterSetter('lines', util.toArray, util.toArray);
Editor.prototype.text = function (text) {
  if (arguments.length) {
    text = text.toString();
    this.emit('change', text);
    return this.lines(Editor._splitLines(text));
  } else {
    return this.data.lines.join('');
  }
};
Editor.prototype._textChanged = function () {
  this.emit('lines', this.lines());
  this.emit('change', this.text());
  return this;
};

Editor.prototype.line = function (n, stripLineEnding) {
  var line = this.data.lines[arguments.length
    ? Math.max(Math.min(n, this.data.lines.length - 1), 0)
    : this.cursor().y
  ];
  if (stripLineEnding) { line = line.replace(Editor._lineRegExp, ''); }
  return line;
};

Editor.prototype.textRange = function (start, end) {
  return this.data.lines
    .slice(start.y, end.y + 1)
    .map(function (line, i) {
      if (i + start.y === end.y) { line = line.slice(0, end.x); }
      if (i === 0) { line = line.slice(start.x); }
      return line;
    }).join('');
};

Editor.prototype.change = function (text, start, end) {
  if (arguments.length < 3) {
    if (arguments.length === 1) { start = this.select(); }
    end = start.end; start = start.start;
  }

  var lines = Editor._splitLines(text);
  lines.unshift(this.line(start.y).slice(0, start.x) + (lines.shift() || ''));
  lines.push(lines.pop() + this.line(end.y).slice(end.x));

  [].splice.apply(this.data.lines, [start.y, end.y - start.y + 1].concat(lines));
  return this
    .select(null, start)
    .moveCursorHorizontal(text.length)
    ._textChanged();
};
Editor.prototype.delete = function () {
  return this.change.apply(this, [''].concat(util.toArray(arguments)));
};

Editor.prototype.visiblePos = function (pos) {
  pos.x = this.line(pos.y)
    .slice(0, pos.x)
    .replace(/\t/g, _.repeat('\t', this.options.tabSize).join(''))
    .length;
  return pos;
};
Editor.prototype.realPos = function (pos) {
  var expandedTab = _.repeat('\t', this.options.tabSize).join('');
  pos.x = this.line(pos.y)
    .replace(/\t/g, expandedTab)
    .slice(0, pos.x)
    .split(expandedTab).join('\t') //.replace(expandedTab, '\t')
    .length;
  return pos;
};

Editor.prototype.scroll = util.getterSetter('scroll', util.clone, Coordinate.setter(function (c) {
  if (!this.data.maxWidth) { this.data.maxWidth = 0; }
  return {
    x: this.data.maxWidth,
    y: this.data.lines.length
  };
}));

var cursorSetter = Coordinate.setter(function (c) {
  var line = this.line(c.y, true);
  return {
    x: (line || '').length,
    y: this.data.lines.length - 1
  };
});

Editor.prototype.cursor = util.getterSetter('cursor', util.clone, function (c, updatePreferredX) {
  var cursor = cursorSetter.apply(this, arguments);
  if (typeof updatePreferredX === 'undefined' || updatePreferredX) {
    this.data.preferredCursorX = this.visiblePos(cursor).x;
  }
  return cursor;
});
Editor.prototype.moveCursorVertical = function (count, paragraphs) {
  var self = this;

  var cursor = self.cursor();

  if (paragraphs) {
    paragraphs = Math.abs(count);
    var direction = paragraphs / count;
    while (paragraphs--) {
      while (true) {
        cursor.y += direction;

        if (!(0 <= cursor.y && cursor.y < self.data.lines.length - 1)) { break; }
        if (/^\s*$/g.test(self.line(cursor.y, true))) { break; }
      }
    }
  } else {
    cursor.y += count;
  }

  self.cursor({
    x: Math.max(0, cursor.y < self.data.lines.length
      ? self.realPos({x: self.data.preferredCursorX, y: cursor.y}).x
      : self.line(cursor.y, true).length
    ),
    y: cursor.y
  }, false);
  

  return self;
};
Editor.prototype.moveCursorHorizontal = function (count, words) {
  var self = this;

  var cursor = self.cursor();

  if (words) {
    words = Math.abs(count);
    var direction = words / count;
    while (words--) {
      var line = self.line(cursor.y, true);
      var wordMatch = word[direction === -1 ? 'prev' : 'current'](line, cursor.x);
      cursor = self.moveCursorHorizontal(direction * Math.max(1, {
        '-1': cursor.x - (wordMatch ? wordMatch.index : 0),
        '1': (wordMatch ? wordMatch.index + wordMatch[0].length : line.length) - cursor.x
      }[direction])).cursor();
    }
  } else {
    while (true) {
      if (-count > cursor.x) {
        // Up a line
        count += cursor.x + 1;
        if (cursor.y > 0) {
          cursor.y -= 1;
          cursor.x = self.line(cursor.y, true).length;
        }
      } else {
        var restOfLineLength = self.line(cursor.y, true).length - cursor.x;
        if (count > restOfLineLength) {
          // Down a line
          count -= restOfLineLength + 1;
          if (cursor.y < self.data.lines.length - 1) {
            cursor.x = 0;
            cursor.y += 1;
          }
        } else {
          // Same line
          cursor.x += count;
          self.cursor(cursor);
          break;
        }
      }
    }
  }

  return self;
};

Editor.prototype.insertMode = util.getterSetter('insertMode', null, Boolean);
Editor.prototype.toggleInsertMode = function () { return this.insertMode(!this.insertMode()); };

Editor.prototype.startSelection = util.getterSetter('startSelection', function (c) {
  return c ? util.clone(c) : c;
}, function (c) {
  if (c === null) { return null; }
  return cursorSetter.apply(this, arguments);
});

Editor.prototype.select = function (start, end) {
  if (arguments.length) {
    if (arguments.length === 1) {
      if (start === null) { return this.startSelection(start); }
      end = start;
      start = this.cursor();
    }
    return this
      .startSelection(start)
      .cursor(end);
  } else {
    var cursor = this.cursor();
    var selectionBounds = [this.startSelection() || cursor, cursor];
    selectionBounds.sort(Coordinate.linear.cmp);
    return {
      start: selectionBounds[0],
      end: selectionBounds[1],
      text: this.textRange(selectionBounds[0], selectionBounds[1])
    };
  }
};

Editor.prototype.pos = function () {
  return {
    x: this.left + this.ileft,
    y: this.top + this.itop
  };
};

Editor.prototype.size = function () {
  return {
    x: this.width - this.iwidth,
    y: this.height - this.iheight
  };
};

Editor._markupRegExp = /{(\/?)([\w\-,;!#]*)}/g;
Editor._markupIndex = function (markup, index) {
  var markupLength = 0;
  var textLength = markup
    .replace(Editor._markupRegExp, function (match, close, tag, i) {
      var replace = {open: '{', close: '}'}[tag] || '';
      if (i < index + markupLength) { markupLength += match.length - replace.length; }
      return replace;
    })
    .slice(0, index)
    .length;
  return textLength + markupLength;
}

Editor.prototype._updateCursor = function () {
  var self = this;
  var cursorOnScreen = Coordinate(self.pos()).add(self.visiblePos(this.cursor())).subtract(self.scroll());
  self.screen.program.move(cursorOnScreen.x, cursorOnScreen.y);
};
Editor.prototype._editorRender = function () {
  var self = this;

  var scroll = self.scroll();
  var selection = self.select();

  var endSelectStyle = self.options.selectStyle.replace(Editor._markupRegExp, '{!$1$2}', 'g'); // 'g' flag ignored :(

  self.setContent(self.data.lines
//    .concat(_.repeat('', self.size().y).toArray())
    .slice(scroll.y, scroll.y + self.size().y)
    .map(function (line, y) {
      y += scroll.y;

      line = (line.replace(Editor._lineRegExp, '') + _.repeat(' ', self.size().x).join(''))
        .slice(scroll.x, scroll.x + self.size().x)
        .replace(/[{}]/g, function (match) {
          return {'{': '{open}', '}': '{close}'}[match];
        });

      if (selection && selection.start.y <= y && y <= selection.end.y) {
        var start = y === selection.start.y ? Editor._markupIndex(line, selection.start.x - scroll.x) : 0;
        var end = y === selection.end.y ? Editor._markupIndex(line, selection.end.x - scroll.x) : Infinity;
        line = line.slice(0, start) +
          self.options.selectStyle + line.slice(start, end) + endSelectStyle +
          line.slice(end);
      }

      return line;
    })
    .join('\n'));

  self.screen.render();

  return self;
};

module.exports = Editor;
