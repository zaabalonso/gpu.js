/// Normalize the precompilled string or object as an object
///
/// @param  Compilled kernel as an object or string
///
/// @return  Precompiled object
function normalizeKernelObj(compiledKernelObj) {
	if( typeof compiledKernelObj == "string" ) {
		return JSON.parse(compiledKernelObj);
	}
	return compiledKernelObj;
}

/// Checks the arguments if it complied to the config
///
/// @param   Arguments santization check 
///
/// @return  The arguments if valid, else throw an exception
function checkArguments(paramType, args) {
	for(var i=0; i<paramType.length; i++) {

		// Getting the argument / param type
		var argToCheck = args[i];
		var paramToCheck = paramType[i];
		var argType = GPUUtils.getArgumentType(argToCheck);

		// Check the parameters, throw if fail
		if( paramToCheck != argType ) {
			throw "Invalid argument type for index "+i+" : "+paramToCheck+" / "+argType;
		} 
	}
}

/// The precompiled GPU create kernel build function
///
/// @param  Compilled kernel as an object or string
function PrecompilledGPU(kernelObj, inOpt) {

	// Normalize the kernel
	kernelObj = normalizeKernelObj(kernelObj);

	// Get the respective info
	var opt = kernelObj.opt;
	var paramType = kernelObj.paramType;
	var jsKernelFuncStr = kernelObj.jsKernelFunc;
	var gpuKernelFuncStr = kernelObj.gpuKernelFunc;

	// The option overwrite
	opt = Object.assign(opt, inOpt);

	//-----------------------------------------------------------------------------------------
	//
	// CPU specific implementation
	//
	//-----------------------------------------------------------------------------------------

	/// Run in CPU mode
	///
	/// @param  The arguments used
	function _mode_cpu(args) {

		// The jsKernel
		var jsKernelFunc = null;
		eval("jsKernelFunc = "+jsKernelFuncStr);

		// Check the kernel func
		if( jsKernelFunc == null ) {
			throw "Failed to process JS Kernel Function : "+jsKernelFuncStr;
		}
		
		// Intialize the CPU canvas
		var gpu = this;
		var canvas = gpu._canvasCpu;
		if (!canvas) {
			canvas = gpu._canvasCpu = GPUUtils.init_canvas();
		}
		
		// Getting the option dimensions
		var threadDim = GPUUtils.clone(opt.dimensions);

		// Does at a minimum 3 dimensional computational
		while (threadDim.length < 3) {
			threadDim.push(1);
		}

		// Setup the possible return result
		var ret = new Array(threadDim[2]);
		for (var i=0; i<threadDim[2]; i++) {
			ret[i] = new Array(threadDim[1]);
			for (var j=0; j<threadDim[1]; j++) {
				ret[i][j] = new Array(threadDim[0]);
			}
		}

		// Context setup (for local this.x support)
		var ctx = {
			thread: {
				x: 0,
				y: 0,
				z: 0
			},
			dimensions: {
				x: threadDim[0],
				y: threadDim[1],
				z: threadDim[2]
			},
			constants: opt.constants
		};

		// Canvas and image data (if graphical mode)
		var canvasCtx;
		var imageData;
		var data;
		if (opt.graphical) {
			canvas.width = threadDim[0];
			canvas.height = threadDim[1];

			canvasCtx = canvas.getContext("2d");
			imageData = canvasCtx.createImageData(threadDim[0], threadDim[1]);
			data = new Uint8ClampedArray(threadDim[0]*threadDim[1]*4);
			
			ctx.color = function(r, g, b, a) {
				if (a == undefined) {
					a = 1.0;
				}

				r = Math.floor(r * 255);
				g = Math.floor(g * 255);
				b = Math.floor(b * 255);
				a = Math.floor(a * 255);

				var width = ctx.dimensions.x;
				var height = ctx.dimensions.y;

				var x = ctx.thread.x;
				var y = height - ctx.thread.y - 1;

				var index = x + y*width;

				data[index*4+0] = r;
				data[index*4+1] = g;
				data[index*4+2] = b;
				data[index*4+3] = a;
			};
		}

		// Runs and return the kernel result
		for (ctx.thread.z=0; ctx.thread.z<threadDim[2]; ctx.thread.z++) {
			for (ctx.thread.y=0; ctx.thread.y<threadDim[1]; ctx.thread.y++) {
				for (ctx.thread.x=0; ctx.thread.x<threadDim[0]; ctx.thread.x++) {
					ret[ctx.thread.z][ctx.thread.y][ctx.thread.x] = jsKernelFunc.apply(ctx, args);
				}
			}
		}

		// Update the graphical canvas (for opt.graphical)
		if (opt.graphical) {
			imageData.data.set(data);
			canvasCtx.putImageData(imageData, 0, 0);
		}

		// Collapsing and normalizing the results
		if (opt.dimensions.length == 1) {
			ret = ret[0][0];
		} else if (opt.dimensions.length == 2) {
			ret = ret[0];
		}

		// Return the result
		return ret;
	}

	//-----------------------------------------------------------------------------------------
	//
	// GPU specific utility functions
	//
	//-----------------------------------------------------------------------------------------

	// Dimensions to actual textual size
	function dimToTexSize(opt, dimensions, output) {
		var numTexels = dimensions[0];
		for (var i=1; i<dimensions.length; i++) {
			numTexels *= dimensions[i];
		}

		if (opt.floatTextures && (!output || opt.floatOutput)) {
			numTexels = Math.ceil(numTexels / 4);
		}

		var w = Math.ceil(Math.sqrt(numTexels));
		return [w, w];
	}

	function flatten(arr) {
		if (GPUUtils.isArray(arr[0])) {
			if (GPUUtils.isArray(arr[0][0])) {
				// Annoyingly typed arrays do not have concat so we turn them into arrays first
				if (!Array.isArray(arr[0][0])) {
					return [].concat.apply([], [].concat.apply([], arr).map(function(x) {
						return Array.prototype.slice.call(x);
					}));
				}

				return [].concat.apply([], [].concat.apply([], arr));
			} else {
				return [].concat.apply([], arr);
			}
		} else {
			return arr;
		}
	}

	function splitArray(array, part) {
		var tmp = [];
		for(var i = 0; i < array.length; i += part) {
			tmp.push(array.slice(i, i + part));
		}
		return tmp;
	}

	function getProgramCacheKey(args, opt, outputDim) {
		var key = '';
		for (var i=0; i<args.length; i++) {
			var argType = GPUUtils.getArgumentType(args[i]);
			key += argType;
			if (opt.hardcodeConstants) {
				var dimensions;
				if (argType == "Array" || argType == "Texture") {
					dimensions = getDimensions(args[i], true);
					key += '['+dimensions[0]+','+dimensions[1]+','+dimensions[2]+']';
				}
			}
		}

		var specialFlags = '';
		if (opt.wraparound) {
			specialFlags += "Wraparound";
		}

		if (opt.hardcodeConstants) {
			specialFlags += "Hardcode";
			specialFlags += '['+outputDim[0]+','+outputDim[1]+','+outputDim[2]+']';
		}

		if (opt.constants) {
			specialFlags += "Constants";
			specialFlags += JSON.stringify(opt.constants);
		}

		if (specialFlags) {
			key = key + '-' + specialFlags;
		}
		return key;
	}

	function getDimensions(x, pad) {
		var ret;
		if (GPUUtils.isArray(x)) {
			var dim = [];
			var temp = x;
			while (GPUUtils.isArray(temp)) {
				dim.push(temp.length);
				temp = temp[0];
			}
			ret = dim.reverse();
		} else if (x instanceof GPUTexture) {
			ret = x.dimensions;
		} else {
			throw "Unknown dimensions of " + x;
		}

		if (pad) {
			ret = GPUUtils.clone(ret);
			while (ret.length < 3) {
				ret.push(1);
			}
		}

		return ret;
	}

	//-----------------------------------------------------------------------------------------
	//
	// GPU implementation
	//
	//-----------------------------------------------------------------------------------------

	/// Run in GPU mode
	///
	/// @param  The arguments used
	function _mode_gpu(args) {

		// Get / Initialize the canvas
		var canvas = this._canvas;
		if (!canvas) {
			canvas = this._canvas = GPUUtils.init_canvas();
		}

		// Get / Initialize the webgl
		var gl = this._webgl;
		if (!gl) {
			gl = this._webgl = GPUUtils.init_webgl(canvas);
		}

		// Get the system endianness
		var endianness = GPUUtils.systemEndianness();

		// Cache setup
		var programCache = {};
		var programUniformLocationCache = {};
		var bufferCache = {};
		var textureCache = {};
		var framebufferCache = {};
		var paramNames = kernelObj.paramNames;

		// Setup vertices and texture cordinates
		var vertices = new Float32Array([
			-1, -1,
			1, -1,
			-1, 1,
			1, 1]);
		var texCoords = new Float32Array([
			0.0, 0.0,
			1.0, 0.0,
			0.0, 1.0,
			1.0, 1.0]);

		// Does float texture support checks
		if (opt.floatTextures === true && !GPUUtils.OES_texture_float) {
			throw "Float textures are not supported on this browser";
		} else if (opt.floatOutput === true && opt.floatOutputForce !== true && !GPUUtils.test_floatReadPixels(gpu)) {
			throw "Float texture outputs are not supported on this browser";
		} else if (opt.floatTextures === undefined && GPUUtils.OES_texture_float) {
			opt.floatTextures = true;
			opt.floatOutput = /*GPUUtils.test_floatReadPixels(gpu)*/ true && !opt.graphical;
		}

		// Dimensions are compulsory
		if (!opt.dimensions || opt.dimensions.length === 0) {
			throw "Dimensions must be configured for precompilled mode";
		}

		// Gets textual size to use
		var texSize = dimToTexSize(opt, opt.dimensions, true);

		// Graphical mode checks
		if (opt.graphical) {
			if (opt.dimensions.length != 2) {
				throw "Output must have 2 dimensions on graphical mode";
			}

			if (opt.floatOutput) {
				throw "Cannot use graphical mode and float output at the same time";
			}

			texSize = GPUUtils.clone(opt.dimensions);
		} else if (opt.floatOutput === undefined && GPUUtils.OES_texture_float) {
			opt.floatOutput = true;
		}

		// Canvas setup
		canvas.width = texSize[0];
		canvas.height = texSize[1];
		gl.viewport(0, 0, texSize[0], texSize[1]);

		// The minimum dimension to process 3
		var threadDim = GPUUtils.clone(opt.dimensions);
		while (threadDim.length < 3) {
			threadDim.push(1);
		}

		// Setup the program cache
		var programCacheKey = getProgramCacheKey(arguments, opt, opt.dimensions);
		var program = programCache[programCacheKey];

		// Get uniform location
		function getUniformLocation(name) {
			var location = programUniformLocationCache[programCacheKey][name];
			if (!location) {
				location = gl.getUniformLocation(program, name);
				programUniformLocationCache[programCacheKey][name] = location;
			}
			return location;
		}

		// Setup the program : to execute in canvas
		if (program === undefined) {

			// Get and setup the constants
			var constantsStr = '';
			if (opt.constants) {
				for (var name in opt.constants) {
					var value = parseFloat(opt.constants[name]);

					if (Number.isInteger(value)) {
						constantsStr += 'const float constants_' + name + '=' + parseInt(value) + '.0;\n';
					} else {
						constantsStr += 'const float constants_' + name + '=' + parseFloat(value) + ';\n';
					}
				}
			}

			// Parameter str and type setup
			var paramStr = '';
			for (var i=0; i<paramNames.length; i++) {
				var argType = GPUUtils.getArgumentType(arguments[i]);
				
				// Validate the param and argument type
				if( argType != paramType[i] ) {
					throw "Invalid argument / parameter type : "+argType+" / "+paramType[i];
				}

				// Setup the hardcoded constants
				if (opt.hardcodeConstants) {
					if (argType == "Array" || argType == "Texture") {
						var paramDim = getDimensions(arguments[i], true);
						var paramSize = dimToTexSize(gpu, paramDim);

						paramStr += 'uniform highp sampler2D user_' + paramNames[i] + ';\n';
						paramStr += 'highp vec2 user_' + paramNames[i] + 'Size = vec2(' + paramSize[0] + '.0, ' + paramSize[1] + '.0);\n';
						paramStr += 'highp vec3 user_' + paramNames[i] + 'Dim = vec3(' + paramDim[0] + '.0, ' + paramDim[1] + '.0, ' + paramDim[2] + '.0);\n';
					} else if (argType == "Number" && Number.isInteger(arguments[i])) {
						paramStr += 'highp float user_' + paramNames[i] + ' = ' + arguments[i] + '.0;\n';
					} else if (argType == "Number") {
						paramStr += 'highp float user_' + paramNames[i] + ' = ' + arguments[i] + ';\n';
					}
				} else {
					if (argType == "Array" || argType == "Texture") {
						paramStr += 'uniform highp sampler2D user_' + paramNames[i] + ';\n';
						paramStr += 'uniform highp vec2 user_' + paramNames[i] + 'Size;\n';
						paramStr += 'uniform highp vec3 user_' + paramNames[i] + 'Dim;\n';
					} else if (argType == "Number") {
						paramStr += 'uniform highp float user_' + paramNames[i] + ';\n';
					}
				}
			}

			// The vertex string
			var vertShaderSrc = [
				'precision highp float;',
				'precision highp int;',
				'precision highp sampler2D;',
				'',
				'attribute highp vec2 aPos;',
				'attribute highp vec2 aTexCoord;',
				'',
				'varying highp vec2 vTexCoord;',
				'',
				'void main(void) {',
				'   gl_Position = vec4(aPos, 0, 1);',
				'   vTexCoord = aTexCoord;',
				'}'
			].join('\n');

			// The fragment shader
			var fragShaderSrc = [
				'precision highp float;',
				'precision highp int;',
				'precision highp sampler2D;',
				'',
				'#define LOOP_MAX '+ (opt.loopMaxIterations ? parseInt(opt.loopMaxIterations)+'.0' : '100.0'),
				'#define EPSILON 0.0000001',
				'',
				opt.hardcodeConstants ? 'highp vec3 uOutputDim = vec3('+threadDim[0]+','+threadDim[1]+', '+ threadDim[2]+');' : 'uniform highp vec3 uOutputDim;',
				opt.hardcodeConstants ? 'highp vec2 uTexSize = vec2('+texSize[0]+','+texSize[1]+');' : 'uniform highp vec2 uTexSize;',
				'varying highp vec2 vTexCoord;',
				'',
				'vec4 round(vec4 x) {',
				'	return floor(x + 0.5);',
				'}',
				'',
				'highp float round(highp float x) {',
				'	return floor(x + 0.5);',
				'}',
				'',
				'vec2 integerMod(vec2 x, float y) {',
				'	vec2 res = floor(mod(x, y));',
				'	return res * step(1.0 - floor(y), -res);',
				'}',
				'',
				'vec3 integerMod(vec3 x, float y) {',
				'	vec3 res = floor(mod(x, y));',
				'	return res * step(1.0 - floor(y), -res);',
				'}',
				'',
				'vec4 integerMod(vec4 x, vec4 y) {',
				'	vec4 res = floor(mod(x, y));',
				'	return res * step(1.0 - floor(y), -res);',
				'}',
				'',
				'highp float integerMod(highp float x, highp float y) {',
				'	highp float res = floor(mod(x, y));',
				'	return res * (res > floor(y) - 1.0 ? 0.0 : 1.0);',
				'}',
				'',
				'highp int integerMod(highp int x, highp int y) {',
				'	return int(integerMod(float(x), float(y)));',
				'}',
				'',
				'// Here be dragons!',
				'// DO NOT OPTIMIZE THIS CODE',
				'// YOU WILL BREAK SOMETHING ON SOMEBODY\'S MACHINE',
				'// LEAVE IT AS IT IS, LEST YOU WASTE YOUR OWN TIME',
				'const vec2 MAGIC_VEC = vec2(1.0, -256.0);',
				'const vec4 SCALE_FACTOR = vec4(1.0, 256.0, 65536.0, 0.0);',
				'const vec4 SCALE_FACTOR_INV = vec4(1.0, 0.00390625, 0.0000152587890625, 0.0); // 1, 1/256, 1/65536',
				'highp float decode32(highp vec4 rgba) {',
				(endianness == 'LE' ? '' : '	rgba.rgba = rgba.abgr;'),
				'	rgba *= 255.0;',
				'	vec2 gte128;',
				'	gte128.x = rgba.b >= 128.0 ? 1.0 : 0.0;',
				'	gte128.y = rgba.a >= 128.0 ? 1.0 : 0.0;',
				'	float exponent = 2.0 * rgba.a - 127.0 + dot(gte128, MAGIC_VEC);',
				'	float res = exp2(round(exponent));',
				'	rgba.b = rgba.b - 128.0 * gte128.x;',
				'	res = dot(rgba, SCALE_FACTOR) * exp2(round(exponent-23.0)) + res;',
				'	res *= gte128.y * -2.0 + 1.0;',
				'	return res;',
				'}',
				'',
				'highp vec4 encode32(highp float f) {',
				'	highp float F = abs(f);',
				'	highp float sign = f < 0.0 ? 1.0 : 0.0;',
				'	highp float exponent = floor(log2(F));',
				'	highp float mantissa = (exp2(-exponent) * F);',
				'	// exponent += floor(log2(mantissa));',
				'	vec4 rgba = vec4(F * exp2(23.0-exponent)) * SCALE_FACTOR_INV;',
				'	rgba.rg = integerMod(rgba.rg, 256.0);',
				'	rgba.b = integerMod(rgba.b, 128.0);',
				'	rgba.a = exponent*0.5 + 63.5;',
				'	rgba.ba += vec2(integerMod(exponent+127.0, 2.0), sign) * 128.0;',
				'	rgba = floor(rgba);',
				'	rgba *= 0.003921569; // 1/255',
				(endianness == 'LE' ? '' : '	rgba.rgba = rgba.abgr;'),
				'	return rgba;',
				'}',
				'// Dragons end here',
				'',
				'highp float index;',
				'highp vec3 threadId;',
				'',
				'highp vec3 indexTo3D(highp float idx, highp vec3 texDim) {',
				'	highp float z = floor(idx / (texDim.x * texDim.y));',
				'	idx -= z * texDim.x * texDim.y;',
				'	highp float y = floor(idx / texDim.x);',
				'	highp float x = integerMod(idx, texDim.x);',
				'	return vec3(x, y, z);',
				'}',
				'',
				'highp float get(highp sampler2D tex, highp vec2 texSize, highp vec3 texDim, highp float z, highp float y, highp float x) {',
				'	highp vec3 xyz = vec3(x, y, z);',
				'	xyz = floor(xyz + 0.5);',
				(opt.wraparound ? '	xyz = mod(xyz, texDim);' : ''),
				'	highp float index = round(xyz.x + texDim.x * (xyz.y + texDim.y * xyz.z));',
				(opt.floatTextures ? '	int channel = int(integerMod(index, 4.0));' : ''),
				(opt.floatTextures ? '	index = float(int(index)/4);' : ''),
				'	highp float w = round(texSize.x);',
				'	vec2 st = vec2(integerMod(index, w), float(int(index) / int(w))) + 0.5;',
				(opt.floatTextures ? '	index = float(int(index)/4);' : ''),
				'	highp vec4 texel = texture2D(tex, st / texSize);',
				(opt.floatTextures ? '	if (channel == 0) return texel.r;' : ''),
				(opt.floatTextures ? '	if (channel == 1) return texel.g;' : ''),
				(opt.floatTextures ? '	if (channel == 2) return texel.b;' : ''),
				(opt.floatTextures ? '	if (channel == 3) return texel.a;' : ''),
				(opt.floatTextures ? '' : '	return decode32(texel);'),
				'}',
				'',
				'highp float get(highp sampler2D tex, highp vec2 texSize, highp vec3 texDim, highp float y, highp float x) {',
				'	return get(tex, texSize, texDim, 0.0, y, x);',
				'}',
				'',
				'highp float get(highp sampler2D tex, highp vec2 texSize, highp vec3 texDim, highp float x) {',
				'	return get(tex, texSize, texDim, 0.0, 0.0, x);',
				'}',
				'',
				'const bool outputToColor = ' + (opt.graphical? 'true' : 'false') + ';',
				'highp vec4 actualColor;',
				'void color(float r, float g, float b, float a) {',
				'	actualColor = vec4(r,g,b,a);',
				'}',
				'',
				'void color(float r, float g, float b) {',
				'	color(r,g,b,1.0);',
				'}',
				'',
				'highp float kernelResult = 0.0;',
				paramStr,
				constantsStr,
				// The precompilled gpu kernel str
				gpuKernelFuncStr,
				'',
				'void main(void) {',
				'	index = floor(vTexCoord.s * float(uTexSize.x)) + floor(vTexCoord.t * float(uTexSize.y)) * uTexSize.x;',
				(opt.floatOutput ? 'index *= 4.0;' : ''),
				'	threadId = indexTo3D(index, uOutputDim);',
				'	kernel();',
				'	if (outputToColor == true) {',
				'		gl_FragColor = actualColor;',
				'	} else {',
				(opt.floatOutput ? '' : 'gl_FragColor = encode32(kernelResult);'),
				(opt.floatOutput ? 'gl_FragColor.r = kernelResult;' : ''),
				(opt.floatOutput ? 'index += 1.0; threadId = indexTo3D(index, uOutputDim); kernel();' : ''),
				(opt.floatOutput ? 'gl_FragColor.g = kernelResult;' : ''),
				(opt.floatOutput ? 'index += 1.0; threadId = indexTo3D(index, uOutputDim); kernel();' : ''),
				(opt.floatOutput ? 'gl_FragColor.b = kernelResult;' : ''),
				(opt.floatOutput ? 'index += 1.0; threadId = indexTo3D(index, uOutputDim); kernel();' : ''),
				(opt.floatOutput ? 'gl_FragColor.a = kernelResult;' : ''),
				'	}',
				'}'
			].join('\n');

			var vertShader = gl.createShader(gl.VERTEX_SHADER);
			var fragShader = gl.createShader(gl.FRAGMENT_SHADER);

			gl.shaderSource(vertShader, vertShaderSrc);
			gl.shaderSource(fragShader, fragShaderSrc);

			gl.compileShader(vertShader);
			gl.compileShader(fragShader);

			if (!gl.getShaderParameter(vertShader, gl.COMPILE_STATUS)) {
				console.log(vertShaderSrc);
				console.error("An error occurred compiling the shaders: " + gl.getShaderInfoLog(vertShader));
				throw "Error compiling vertex shader";
			}
			if (!gl.getShaderParameter(fragShader, gl.COMPILE_STATUS)) {
				console.log(fragShaderSrc);
				console.error("An error occurred compiling the shaders: " + gl.getShaderInfoLog(fragShader));
				throw "Error compiling fragment shader";
			}

			if (opt.debug) {
				console.log('Options:');
				console.dir(opt);
				console.log('GLSL Shader Output:');
				console.log(fragShaderSrc);
			}

			program = gl.createProgram();
			gl.attachShader(program, vertShader);
			gl.attachShader(program, fragShader);
			gl.linkProgram(program);

			programCache[programCacheKey] = program;
			programUniformLocationCache[programCacheKey] = [];
		}

		gl.useProgram(program);

		var texCoordOffset = vertices.byteLength;
		var buffer = bufferCache[programCacheKey];
		if (!buffer) {
			buffer = gl.createBuffer();
			bufferCache[programCacheKey] = buffer;

			gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
			gl.bufferData(gl.ARRAY_BUFFER, vertices.byteLength + texCoords.byteLength, gl.STATIC_DRAW);
		} else {
			gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		}
		gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices);
		gl.bufferSubData(gl.ARRAY_BUFFER, texCoordOffset, texCoords);

		var aPosLoc = gl.getAttribLocation(program, "aPos");
		gl.enableVertexAttribArray(aPosLoc);
		gl.vertexAttribPointer(aPosLoc, 2, gl.FLOAT, gl.FALSE, 0, 0);
		var aTexCoordLoc = gl.getAttribLocation(program, "aTexCoord");
		gl.enableVertexAttribArray(aTexCoordLoc);
		gl.vertexAttribPointer(aTexCoordLoc, 2, gl.FLOAT, gl.FALSE, 0, texCoordOffset);

		if (!opt.hardcodeConstants) {
			var uOutputDimLoc = getUniformLocation("uOutputDim");
			gl.uniform3fv(uOutputDimLoc, threadDim);
			var uTexSizeLoc = getUniformLocation("uTexSize");
			gl.uniform2fv(uTexSizeLoc, texSize);
		}

		if (!textureCache[programCacheKey]) {
			textureCache[programCacheKey] = [];
		}
		var textureCount = 0;
		for (textureCount=0; textureCount<paramNames.length; textureCount++) {
			var paramDim, paramSize, texture;
			var argType = GPUUtils.getArgumentType(arguments[textureCount]);
			if (argType == "Array") {
				paramDim = getDimensions(arguments[textureCount], true);
				paramSize = dimToTexSize(opt, paramDim);

				if (textureCache[programCacheKey][textureCount]) {
					texture = textureCache[programCacheKey][textureCount];
				} else {
					texture = gl.createTexture();
					textureCache[programCacheKey][textureCount] = texture;
				}

				gl.activeTexture(gl["TEXTURE"+textureCount]);
				gl.bindTexture(gl.TEXTURE_2D, texture);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

				var paramLength = paramSize[0] * paramSize[1];
				if (opt.floatTextures) {
					paramLength *= 4;
				}

				var paramArray = new Float32Array(paramLength);
				paramArray.set(flatten(arguments[textureCount]))

				var argBuffer;
				if (opt.floatTextures) {
					argBuffer = new Float32Array(paramArray);
					gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, paramSize[0], paramSize[1], 0, gl.RGBA, gl.FLOAT, argBuffer);
				} else {
					argBuffer = new Uint8Array((new Float32Array(paramArray)).buffer);
					gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, paramSize[0], paramSize[1], 0, gl.RGBA, gl.UNSIGNED_BYTE, argBuffer);
				}

				var paramLoc = getUniformLocation("user_" + paramNames[textureCount]);
				var paramSizeLoc = getUniformLocation("user_" + paramNames[textureCount] + "Size");
				var paramDimLoc = getUniformLocation("user_" + paramNames[textureCount] + "Dim");

				if (!opt.hardcodeConstants) {
					gl.uniform3fv(paramDimLoc, paramDim);
					gl.uniform2fv(paramSizeLoc, paramSize);
				}
				gl.uniform1i(paramLoc, textureCount);
			} else if (argType == "Number") {
				var argLoc = getUniformLocation("user_"+paramNames[textureCount]);
				gl.uniform1f(argLoc, arguments[textureCount]);
			} else if (argType == "Texture") {
				paramDim = getDimensions(arguments[textureCount], true);
				paramSize = arguments[textureCount].size;
				texture = arguments[textureCount].texture;

				gl.activeTexture(gl["TEXTURE"+textureCount]);
				gl.bindTexture(gl.TEXTURE_2D, texture);

				var paramLoc = getUniformLocation("user_" + paramNames[textureCount]);
				var paramSizeLoc = getUniformLocation("user_" + paramNames[textureCount] + "Size");
				var paramDimLoc = getUniformLocation("user_" + paramNames[textureCount] + "Dim");

				gl.uniform3fv(paramDimLoc, paramDim);
				gl.uniform2fv(paramSizeLoc, paramSize);
				gl.uniform1i(paramLoc, textureCount);
			} else {
				throw "Input type not supported (GPU): " + arguments[textureCount];
			}
		}

		var outputTexture = textureCache[programCacheKey][textureCount];
		if (!outputTexture) {
			outputTexture = gl.createTexture();
			textureCache[programCacheKey][textureCount] = outputTexture;
		}
		gl.activeTexture(gl["TEXTURE"+textureCount]);
		gl.bindTexture(gl.TEXTURE_2D, outputTexture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		if (opt.floatOutput) {
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, texSize[0], texSize[1], 0, gl.RGBA, gl.FLOAT, null);
		} else {
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, texSize[0], texSize[1], 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
		}

		if (opt.graphical) {
			gl.bindRenderbuffer(gl.RENDERBUFFER, null);
				gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
			return;
		}

		var framebuffer = framebufferCache[programCacheKey];
		if (!framebuffer) {
			framebuffer = gl.createFramebuffer();
			framebufferCache[programCacheKey] = framebuffer;
		}
		framebuffer.width = texSize[0];
		framebuffer.height = texSize[1];
		gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outputTexture, 0);

		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

		if (opt.outputToTexture) {
			// Don't retain a handle on the output texture, we might need to render on the same texture later
			delete textureCache[programCacheKey][textureCount];

			return new GPUTexture(gpu, outputTexture, texSize, opt.dimensions);
		} else {
			var result;
			if (opt.floatOutput) {
				result = new Float32Array(texSize[0]*texSize[1]*4);
				gl.readPixels(0, 0, texSize[0], texSize[1], gl.RGBA, gl.FLOAT, result);
			} else {
				var bytes = new Uint8Array(texSize[0]*texSize[1]*4);
				gl.readPixels(0, 0, texSize[0], texSize[1], gl.RGBA, gl.UNSIGNED_BYTE, bytes);
				result = Float32Array.prototype.slice.call(new Float32Array(bytes.buffer));
			}

			result = result.subarray(0, threadDim[0] * threadDim[1] * threadDim[2]);

			if (opt.dimensions.length == 1) {
				return result;
			} else if (opt.dimensions.length == 2) {
				return splitArray(result, opt.dimensions[0]);
			} else if (opt.dimensions.length == 3) {
				var cube = splitArray(result, opt.dimensions[0] * opt.dimensions[1]);
				return cube.map(function(x) {
					return splitArray(x, opt.dimensions[0]);
				});
			}
		}


	}

	/// The actual run functionality, that takes in the arguments,
	/// and call using the respective mode.
	function run() {
		// Argument check
		var args = Array.prototype.slice.call(arguments);
		checkArguments(paramType, args);

		//  Get the mode
		var mode = opt.computeMode || opt.mode;

		//
		// CPU mode
		//
		if ( mode == "cpu" ) {
			return _mode_cpu(args);
		}

		//
		// Attempts to do the glsl conversion
		//
		try {
			return _mode_gpu(args);
		} catch (e) {
			if ( mode != "gpu") {
				console.warning("Falling back to CPU!");
				opt.computeMode = mode = "cpu";
				return _mode_gpu(args);
			} else {
				throw e;
			}
		}
	}

	/// Get and check webgl support
	run.supportWebgl = GPUUtils.browserSupport_webgl();

	// Return the actual run function
	return run;
};
