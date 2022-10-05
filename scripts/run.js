/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

let path   = require("path"),
    fs     = require("fs"),
    jshint = require("jshint").JSHINT,
    minify = require("jsonminify");

// Older versions of node have `existsSync` in the `path` module, not `fs`. Meh.
fs.existsSync = fs.existsSync || path.existsSync;
path.sep      = path.sep || "/";

let tempPath        = process.argv[2] || "", // The source file to be linted
    filePath        = process.argv[3] || "", // The original source's path
    pluginFolder    = path.dirname(__dirname),
    sourceFolder    = path.dirname(filePath),
    options         = {},
    globals         = {},
    jshintrcPath    = "",
    packagejsonPath = "";

// Some handy utility functions.

function isTrue(value) {
  return value === "true" || value === true;
}

function mergeOptions(source, target) {
  for (let entry in source) {
    if (entry === "globals") {
      if (!target[entry]) {
        target[entry] = {};
      }
      mergeOptions(source[entry], target[entry]);
    } else {
      target[entry] = source[entry];
    }
  }
}

function parseJSON(file) {
  try {
    let opts = JSON.parse(minify(fs.readFileSync(file, "utf8")));
    if (!opts.extends) {
      return opts;
    }

    // Get the opts from base file.
    let baseFile = opts.extends;
    file = path.resolve(path.dirname(file), baseFile);
    let baseOptions = parseJSON(file);

    // Overwrite base opts with local opts.
    delete opts.extends;
    mergeOptions(opts, baseOptions);
    return baseOptions;
  } catch (e) {
    console.log("Could not parse JSON at: " + file);
    return {};
  }
}

function setOptions(file, isPackageJSON, optionsStore, globalsStore) {
  let obj = parseJSON(file);

  // Handle jshintConfig on package.json (NPM) files
  if (isPackageJSON) {
    if (obj.jshintConfig) {
      obj = obj.jshintConfig;
    } else {
      return false;
    }
  }

  for (let key in obj) {
    if (obj.hasOwnProperty(key)) {
      let value = obj[key];

      // Globals are defined as either an array, or an object with keys as names,
      // and a boolean value to determine if they are assignable.
      if (key === "globals" || key === "predef") {
        if (value instanceof Array) {
          for (let i = 0; i < value.length; i++) {
            let name = value[i];
            globalsStore[name] = true;
          }
        } else {
          for (let namez in value) {
            if (value.hasOwnProperty(namez)) {
              globalsStore[namez] = isTrue(value[namez]);
            }
          }
        }
      } else {
        // Special case "true" and "false" pref values as actually booleans.
        // This avoids common accidents in .jshintrc json files.
        if (value === "true" || value === "false") {
          optionsStore[key] = isTrue(value);
        } else {
          optionsStore[key] = value;
        }
      }
    }
  }

  // Options were set successfully.
  return true;
}

function doLint(data, options, globals, lineOffset, charOffset) {
  // Lint the code and write readable error output to the console.
  try {
    jshint(data, options, globals);
  } catch (e) {}

  jshint.errors.sort(function(first, second) {
    first  = first || {};
    second = second || {};

    if (!first.line) {
      return 1;
    } else if (!second.line){
      return -1;
    } else if (first.line === second.line) {
      return +first.character < +second.character ? -1 : 1;
    } else {
      return +first.line < +second.line ? -1 : 1;
    }
  }).forEach(function(e) {
    // If the argument is null, then we could not continue (too many errors).
    if (!e) {
      return;
    }

    // Do some formatting if the error data is available.
    if (e.raw) {
      let message = e.reason;

      if (e.a !== undefined && e.b !== undefined && e.c !== undefined && e.d !== undefined) {
        message = e.raw.replace("{a}", e.a)
                       .replace("{b}", e.b)
                       .replace("{c}", e.c)
                       .replace("{d}", e.d);
      }

      console.log([e.line + lineOffset, e.character + charOffset, message].join(" :: "));
    }
  });
}

function getUserHome() {
  return process.env.HOME || path.join(process.env.HOMEDRIVE, process.env.HOMEPATH) || process.env.USERPROFILE;
}

// end of some handy utility functions.

// Try and get some persistent options from the plugin folder.
if (fs.existsSync(jshintrcPath = pluginFolder + path.sep + ".jshintrc")) {
  setOptions(jshintrcPath, false, options, globals);
}

// When a JSHint config file exists in the same directory as the source file,
// any directory above, or the user's home folder, then use that configuration
// to overwrite the default prefs.
let sourceFolderParts = path.resolve(sourceFolder).split(path.sep),
    pathsToLook       = sourceFolderParts.map((value, key) => sourceFolderParts.slice(0, key + 1).join(path.sep));



// Start with the current directory first, end with the user's home folder.
pathsToLook.reverse();
pathsToLook.push(getUserHome());

pathsToLook.some((pathToLook) => {
  if (fs.existsSync(jshintrcPath = path.join(pathToLook, ".jshintrc"))) {
    return setOptions(jshintrcPath, false, options, globals);
  }

  if (fs.existsSync(packagejsonPath = path.join(pathToLook, "package.json"))) {
    return setOptions(packagejsonPath, true, options, globals);
  }
});

// Dump some diagnostics messages, parsed out by the plugin.
console.log("Using JSHint globals: " + JSON.stringify(globals));
console.log("Using JSHint options: " + JSON.stringify(options, null, 2));

// Read the source file and, when done, lint the code.
fs.readFile(tempPath, "utf8", function(err, data) {
  if (err) {
    return;
  }

  // Mark the output as being from JSHint.
  console.log("*** JSHint output ***");

  // If this is a markup file (html, xml, xhtml etc.), then javascript
  // is maybe present in a <script> tag. Try to extract it and lint.
  if (data.match(/^\s*</)) {
    // First non whitespace character is &lt, so most definitely markup.
    let regexp = /<script[^>]*>([^]*?)<\/script\s*>/gim,
        script = regexp.exec(data);

    while (script) {
      let text       = script[1],                                      // Script contents are captured at index 1.
          prevLines  = data.substr(0, data.indexOf(text)).split("\n"), // Count all the lines up to and including the script tag.
          lineOffset = prevLines.length - 1;

      doLint(text, options, globals, lineOffset, 0);
      script = regexp.exec(data);
    }
  } else {
    doLint(data, options, globals, 0, 0);
  }
});
