import {
  compileCall as compileBuiltinCall,
  compileGetConstant as compileBuiltinGetConstant,
  compileAllocate as compileBuiltinAllocate
} from "./builtins";

import {
  DiagnosticCode,
  DiagnosticEmitter
} from "./diagnostics";

import {
  Module,
  MemorySegment,
  ExpressionRef,
  UnaryOp,
  BinaryOp,
  NativeType,
  FunctionRef,
  ExpressionId,
  FunctionTypeRef
} from "./module";

import {
  Program,
  ClassPrototype,
  Class,
  Element,
  ElementKind,
  Enum,
  Field,
  FunctionPrototype,
  Function,
  FunctionTarget,
  Global,
  Local,
  Namespace,
  EnumValue,
  Property,
  VariableLikeElement,
  FlowFlags,
  ElementFlags,
  ConstantValueKind,

  PATH_DELIMITER,
  LIBRARY_PREFIX
} from "./program";

import {
  Token
} from "./tokenizer";

import {
  Node,
  NodeKind,
  TypeNode,
  Source,
  Range,

  Statement,
  BlockStatement,
  BreakStatement,
  ClassDeclaration,
  ContinueStatement,
  DoStatement,
  EmptyStatement,
  EnumDeclaration,
  ExportStatement,
  ExpressionStatement,
  FunctionDeclaration,
  ForStatement,
  IfStatement,
  ImportStatement,
  InterfaceDeclaration,
  ModifierKind,
  NamespaceDeclaration,
  ReturnStatement,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  VariableDeclaration,
  VariableStatement,
  VoidStatement,
  WhileStatement,

  Expression,
  AssertionExpression,
  BinaryExpression,
  CallExpression,
  CommaExpression,
  ElementAccessExpression,
  FloatLiteralExpression,
  FunctionExpression,
  IdentifierExpression,
  IntegerLiteralExpression,
  LiteralExpression,
  LiteralKind,
  NewExpression,
  ParenthesizedExpression,
  PropertyAccessExpression,
  TernaryExpression,
  ArrayLiteralExpression,
  StringLiteralExpression,
  UnaryPostfixExpression,
  UnaryPrefixExpression,

  hasModifier
} from "./ast";

import {
  Type,
  TypeKind,
  TypeFlags,
  Signature,

  typesToNativeTypes
} from "./types";

/** Compilation target. */
export enum Target {
  /** WebAssembly with 32-bit pointers. */
  WASM32,
  /** WebAssembly with 64-bit pointers. Experimental and not supported by any runtime yet. */
  WASM64
}

/** Compiler options. */
export class Options {

  /** WebAssembly target. Defaults to {@link Target.WASM32}. */
  target: Target = Target.WASM32;
  /** If true, compiles everything instead of just reachable code. */
  noTreeShaking: bool = false;
  /** If true, replaces assertions with nops. */
  noAssert: bool = false;
  /** If true, does not set up a memory. */
  noMemory: bool = false;
  /** If true, imports the memory provided by the embedder. */
  importMemory: bool = false;
  /** Static memory start offset. */
  memoryBase: u32 = 0;
  /** Memory allocation implementation to use. */
  allocateImpl: string = "allocate_memory";
  /** Memory freeing implementation to use. */
  freeImpl: string = "free_memory";
  /** If true, generates information necessary for source maps. */
  sourceMap: bool = false;

  /** Tests if the target is WASM64 or, otherwise, WASM32. */
  get isWasm64(): bool {
    return this.target == Target.WASM64;
  }

  /** Gets the unsigned size type matching the target. */
  get usizeType(): Type {
    return this.target == Target.WASM64 ? Type.usize64 : Type.usize32;
  }

  /** Gets the signed size type matching the target. */
  get isizeType(): Type {
    return this.target == Target.WASM64 ? Type.isize64 : Type.isize32;
  }

  /** Gets the native size type matching the target. */
  get nativeSizeType(): NativeType {
    return this.target == Target.WASM64 ? NativeType.I64 : NativeType.I32;
  }
}

/** Indicates the desired kind of a conversion. */
export const enum ConversionKind {
  /** No conversion. */
  NONE,
  /** Implicit conversion. */
  IMPLICIT,
  /** Explicit conversion. */
  EXPLICIT
}

/** Compiler interface. */
export class Compiler extends DiagnosticEmitter {

  /** Program reference. */
  program: Program;
  /** Provided options. */
  options: Options;
  /** Module instance being compiled. */
  module: Module;

  /** Start function being compiled. */
  startFunction: Function;
  /** Start function statements. */
  startFunctionBody: ExpressionRef[] = [];

  /** Current function in compilation. */
  currentFunction: Function;
  /** Current enum in compilation. */
  currentEnum: Enum | null = null;
  /** Current type in compilation. */
  currentType: Type = Type.void;

  /** Counting memory offset. */
  memoryOffset: I64;
  /** Memory segments being compiled. */
  memorySegments: MemorySegment[] = new Array();
  /** Map of already compiled static string segments. */
  stringSegments: Map<string,MemorySegment> = new Map();

  /** Function table being compiled. */
  functionTable: Function[] = new Array();

  /** Already processed file names. */
  files: Set<string> = new Set();

  /** Compiles a {@link Program} to a {@link Module} using the specified options. */
  static compile(program: Program, options: Options | null = null): Module {
    return new Compiler(program, options).compile();
  }

  /** Constructs a new compiler for a {@link Program} using the specified options. */
  constructor(program: Program, options: Options | null = null) {
    super(program.diagnostics);
    this.program = program;
    if (!options) options = new Options();
    this.options = options;
    this.memoryOffset = i64_new(
      max(options.memoryBase, options.usizeType.byteSize) // leave space for `null`
    );
    this.module = Module.create();
  }

  /** Performs compilation of the underlying {@link Program} to a {@link Module}. */
  compile(): Module {
    var options = this.options;
    var module = this.module;
    var program = this.program;

    // initialize lookup maps, built-ins, imports, exports, etc.
    program.initialize(options);

    // set up the start function wrapping top-level statements, of all files.
    var startFunctionPrototype = assert(program.elements.get("start"));
    assert(startFunctionPrototype.kind == ElementKind.FUNCTION_PROTOTYPE);
    var startFunctionInstance = new Function(
      <FunctionPrototype>startFunctionPrototype,
      startFunctionPrototype.internalName,
      new Signature([], Type.void)
    );
    startFunctionInstance.set(ElementFlags.START);
    this.startFunction = startFunctionInstance;
    this.currentFunction = startFunctionInstance;

    // compile entry file(s) while traversing to reachable elements
    var sources = program.sources;
    for (let i = 0, k = sources.length; i < k; ++i) {
      if (sources[i].isEntry) {
        this.compileSource(sources[i]);
      }
    }

    // compile the start function if not empty
    var startFunctionBody = this.startFunctionBody;
    if (startFunctionBody.length) {
      let typeRef = this.ensureFunctionType(startFunctionInstance.signature);
      let funcRef: FunctionRef;
      module.setStart(
        funcRef = module.addFunction(
          startFunctionInstance.internalName,
          typeRef,
          typesToNativeTypes(startFunctionInstance.additionalLocals),
          module.createBlock(null, startFunctionBody)
        )
      );
      startFunctionInstance.finalize(module, funcRef);
    }

    // set up static memory segments and the heap base pointer
    if (!options.noMemory) {
      let memoryOffset = this.memoryOffset;
      memoryOffset = i64_align(memoryOffset, options.usizeType.byteSize);
      this.memoryOffset = memoryOffset;
      if (options.isWasm64) {
        module.addGlobal(
          "HEAP_BASE",
          NativeType.I64,
          false,
          module.createI64(i64_low(memoryOffset), i64_high(memoryOffset))
        );
      } else {
        module.addGlobal(
          "HEAP_BASE",
          NativeType.I32,
          false,
          module.createI32(i64_low(memoryOffset))
        );
      }

      // determine initial page size
      let pages = i64_shr_u(i64_align(memoryOffset, 0x10000), i64_new(16, 0));
      module.setMemory(
        i64_low(pages),
        Module.MAX_MEMORY_WASM32, // TODO: not WASM64 compatible yet
        this.memorySegments,
        options.target,
        "memory"
      );
    }

    // import memory if requested
    if (options.importMemory) {
      module.addMemoryImport("0", "env", "memory");
    }

    // set up function table
    var functionTable = this.functionTable;
    var functionTableSize = functionTable.length;
    if (functionTableSize) {
      let entries = new Array<FunctionRef>(functionTableSize);
      for (let i = 0; i < functionTableSize; ++i) {
        entries[i] = functionTable[i].ref;
      }
      module.setFunctionTable(entries);
    }

    return module;
  }

  // sources

  compileSourceByPath(normalizedPathWithoutExtension: string, reportNode: Node): void {
    var sources = this.program.sources;

    // try file.ts
    var source: Source;
    var expected = normalizedPathWithoutExtension + ".ts";
    for (let i = 0, k = sources.length; i < k; ++i) {
      source = sources[i];
      if (source.normalizedPath == expected) {
        this.compileSource(source);
        return;
      }
    }

    // try file/index.ts
    expected = normalizedPathWithoutExtension + "/index.ts";
    for (let i = 0, k = sources.length; i < k; ++i) {
      source = sources[i];
      if (source.normalizedPath == expected) {
        this.compileSource(source);
        return;
      }
    }

    // try (lib)/file.ts
    expected = LIBRARY_PREFIX + normalizedPathWithoutExtension + ".ts";
    for (let i = 0, k = sources.length; i < k; ++i) {
      source = sources[i];
      if (source.normalizedPath == expected) {
        this.compileSource(source);
        return;
      }
    }

    this.error(
      DiagnosticCode.File_0_not_found,
      reportNode.range, normalizedPathWithoutExtension
    );
  }

  compileSource(source: Source): void {
    var files = this.files;
    var normalizedPath = source.normalizedPath;
    if (files.has(normalizedPath)) return;
    files.add(normalizedPath);

    // compile top-level statements
    var noTreeShaking = this.options.noTreeShaking;
    var isEntry = source.isEntry;
    var startFunctionBody = this.startFunctionBody;
    var statements = source.statements;
    for (let i = 0, k = statements.length; i < k; ++i) {
      let statement = statements[i];
      switch (statement.kind) {
        case NodeKind.CLASSDECLARATION: {
          let classDeclaration = <ClassDeclaration>statement;
          if (
            (
              noTreeShaking ||
              (isEntry && hasModifier(ModifierKind.EXPORT, classDeclaration.modifiers))
            ) &&
            !classDeclaration.isGeneric
          ) {
            this.compileClassDeclaration(classDeclaration, []);
          }
          break;
        }
        case NodeKind.ENUMDECLARATION: {
          let enumDeclaration = <EnumDeclaration>statement;
          if (
            noTreeShaking ||
            (isEntry && hasModifier(ModifierKind.EXPORT, enumDeclaration.modifiers))
          ) {
            this.compileEnumDeclaration(enumDeclaration);
          }
          break;
        }
        case NodeKind.FUNCTIONDECLARATION: {
          let functionDeclaration = <FunctionDeclaration>statement;
          if (
            (
              noTreeShaking ||
              (isEntry && hasModifier(ModifierKind.EXPORT, functionDeclaration.modifiers))
            ) &&
            !functionDeclaration.isGeneric
          ) {
            this.compileFunctionDeclaration(functionDeclaration, []);
          }
          break;
        }
        case NodeKind.IMPORT: {
          let importStatement = <ImportStatement>statement;
          this.compileSourceByPath(
            importStatement.normalizedPath,
            importStatement.path
          );
          break;
        }
        case NodeKind.NAMESPACEDECLARATION: {
          let namespaceDeclaration = (<NamespaceDeclaration>statement);
          if (
            noTreeShaking ||
            (isEntry && hasModifier(ModifierKind.EXPORT, namespaceDeclaration.modifiers))
          ) {
            this.compileNamespaceDeclaration(namespaceDeclaration);
          }
          break;
        }
        case NodeKind.VARIABLE: { // global, always compiled as initializers might have side effects
          let variableInit = this.compileVariableStatement(<VariableStatement>statement);
          if (variableInit) startFunctionBody.push(variableInit);
          break;
        }
        case NodeKind.EXPORT: {
          let exportStatement = <ExportStatement>statement;
          if (exportStatement.normalizedPath != null) {
            this.compileSourceByPath(
              exportStatement.normalizedPath,
              <StringLiteralExpression>exportStatement.path
            );
          }
          if (noTreeShaking || isEntry) {
            this.compileExportStatement(exportStatement);
          }
          break;
        }
        default: { // otherwise a top-level statement that is part of the start function's body
          let previousFunction = this.currentFunction;
          this.currentFunction = this.startFunction;
          this.startFunctionBody.push(this.compileStatement(statement));
          this.currentFunction = previousFunction;
          break;
        }
      }
    }
  }

  // globals

  compileGlobalDeclaration(declaration: VariableDeclaration): Global | null {
    // look up the initialized program element
    var element = assert(this.program.elements.get(declaration.fileLevelInternalName));
    assert(element.kind == ElementKind.GLOBAL);
    if (!this.compileGlobal(<Global>element)) return null; // reports
    return <Global>element;
  }

  compileGlobal(global: Global): bool {
    if (global.is(ElementFlags.COMPILED) || global.is(ElementFlags.BUILTIN)) return true;
    global.set(ElementFlags.COMPILED);   // ^ built-ins are compiled on use

    var declaration = global.declaration;
    var initExpr: ExpressionRef = 0;

    if (global.type == Type.void) { // type is void if not yet resolved or not annotated

      // resolve now if annotated
      if (declaration.type) {
        let resolvedType = this.program.resolveType(declaration.type); // reports
        if (!resolvedType) return false;
        if (resolvedType == Type.void) {
          this.error(
            DiagnosticCode.Type_expected,
            declaration.type.range
          );
          return false;
        }
        global.type = resolvedType;

      // infer from initializer if not annotated
      } else if (declaration.initializer) { // infer type using void/NONE for literal inference
        initExpr = this.compileExpression( // reports
          declaration.initializer,
          Type.void,
          ConversionKind.NONE
        );
        if (this.currentType == Type.void) {
          this.error(
            DiagnosticCode.Type_0_is_not_assignable_to_type_1,
            declaration.initializer.range, this.currentType.toString(), "<auto>"
          );
          return false;
        }
        global.type = this.currentType;

      // must either be annotated or have an initializer
      } else {
        this.error(
          DiagnosticCode.Type_expected,
          declaration.name.range.atEnd
        );
        return false;
      }
    }

    var nativeType = global.type.toNativeType();

    // handle imports
    if (global.is(ElementFlags.DECLARED)) {

      // constant global
      if (global.is(ElementFlags.CONSTANT)) {
        this.module.addGlobalImport(
          global.internalName,
          global.namespace
            ? global.namespace.simpleName
            : "env",
          global.simpleName,
          nativeType
        );
        global.set(ElementFlags.COMPILED);
        return true;

      // importing mutable globals is not supported in the MVP
      } else {
        this.error(
          DiagnosticCode.Operation_not_supported,
          declaration.range
        );
      }
      return false;
    }

    // the MVP does not yet support initializer expressions other than constant values (and
    // get_globals), hence such initializations must be performed in the start function for now.
    var initializeInStart = false;

    // inlined constant can be compiled as-is
    if (global.is(ElementFlags.INLINED)) {
      initExpr = this.compileInlineConstant(global, global.type, true);

    } else {

      // evaluate initializer if present
      if (declaration.initializer) {
        if (!initExpr) {
          initExpr = this.compileExpression(declaration.initializer, global.type);
        }

        // check if the initializer is constant
        if (_BinaryenExpressionGetId(initExpr) != ExpressionId.Const) {

          // if a constant global, check if the initializer becomes constant after precompute
          if (global.is(ElementFlags.CONSTANT)) {
            initExpr = this.precomputeExpressionRef(initExpr);
            if (_BinaryenExpressionGetId(initExpr) != ExpressionId.Const) {
              this.warning(
                DiagnosticCode.Compiling_constant_with_non_constant_initializer_as_mutable,
                declaration.range
              );
              initializeInStart = true;
            }
          } else {
            initializeInStart = true;
          }
        }

      // initialize to zero if there's no initializer
      } else {
        initExpr = global.type.toNativeZero(this.module);
      }
    }

    var internalName = global.internalName;

    if (initializeInStart) { // initialize to mutable zero and set the actual value in start
      this.module.addGlobal(internalName, nativeType, true, global.type.toNativeZero(this.module));
      this.startFunctionBody.push(this.module.createSetGlobal(internalName, initExpr));

    } else { // compile as-is

      if (global.is(ElementFlags.CONSTANT)) {
        let exprType = _BinaryenExpressionGetType(initExpr);
        switch (exprType) {
          case NativeType.I32: {
            global.constantValueKind = ConstantValueKind.INTEGER;
            global.constantIntegerValue = i64_new(_BinaryenConstGetValueI32(initExpr), 0);
            break;
          }
          case NativeType.I64: {
            global.constantValueKind = ConstantValueKind.INTEGER;
            global.constantIntegerValue = i64_new(
              _BinaryenConstGetValueI64Low(initExpr),
              _BinaryenConstGetValueI64High(initExpr)
            );
            break;
          }
          case NativeType.F32: {
            global.constantValueKind = ConstantValueKind.FLOAT;
            global.constantFloatValue = _BinaryenConstGetValueF32(initExpr);
            break;
          }
          case NativeType.F64: {
            global.constantValueKind = ConstantValueKind.FLOAT;
            global.constantFloatValue = _BinaryenConstGetValueF64(initExpr);
            break;
          }
          default: {
            throw new Error("concrete type expected");
          }
        }
        global.set(ElementFlags.INLINED); // inline the value from now on
        if (declaration.isTopLevel) {     // but keep the element if it might be re-exported
          this.module.addGlobal(internalName, nativeType, false, initExpr);
        }
        if (declaration.range.source.isEntry && declaration.isTopLevelExport) {
          this.module.addGlobalExport(global.internalName, declaration.programLevelInternalName);
        }

      } else /* mutable */ {
        this.module.addGlobal(internalName, nativeType, !global.is(ElementFlags.CONSTANT), initExpr);
      }
    }
    return true;
  }

  // enums

  compileEnumDeclaration(declaration: EnumDeclaration): Enum | null {
    var element = assert(this.program.elements.get(declaration.fileLevelInternalName));
    assert(element.kind == ElementKind.ENUM);
    if (!this.compileEnum(<Enum>element)) return null;
    return <Enum>element;
  }

  compileEnum(element: Enum): bool {
    if (element.is(ElementFlags.COMPILED)) return true;
    element.set(ElementFlags.COMPILED);

    this.currentEnum = element;
    var previousValue: EnumValue | null = null;
    if (element.members) {
      for (let member of element.members.values()) {
        if (member.kind != ElementKind.ENUMVALUE) continue; // happens if an enum is also a namespace
        let initInStart = false;
        let val = <EnumValue>member;
        let valueDeclaration = val.declaration;
        val.set(ElementFlags.COMPILED);
        if (val.is(ElementFlags.INLINED)) {
          if (element.declaration.isTopLevelExport) {
            this.module.addGlobal(
              val.internalName,
              NativeType.I32,
              false, // constant
              this.module.createI32(val.constantValue)
            );
          }
        } else {
          let initExpr: ExpressionRef;
          if (valueDeclaration.value) {
            initExpr = this.compileExpression(<Expression>valueDeclaration.value, Type.i32);
            if (_BinaryenExpressionGetId(initExpr) != ExpressionId.Const) {
              initExpr = this.precomputeExpressionRef(initExpr);
              if (_BinaryenExpressionGetId(initExpr) != ExpressionId.Const) {
                if (element.is(ElementFlags.CONSTANT)) {
                  this.warning(
                    DiagnosticCode.Compiling_constant_with_non_constant_initializer_as_mutable,
                    valueDeclaration.range
                  );
                }
                initInStart = true;
              }
            }
          } else if (previousValue == null) {
            initExpr = this.module.createI32(0);
          } else if (previousValue.is(ElementFlags.INLINED)) {
            initExpr = this.module.createI32(previousValue.constantValue + 1);
          } else {
            // in TypeScript this errors with TS1061, but actually we can do:
            initExpr = this.module.createBinary(BinaryOp.AddI32,
              this.module.createGetGlobal(previousValue.internalName, NativeType.I32),
              this.module.createI32(1)
            );
            if (element.is(ElementFlags.CONSTANT)) {
              this.warning(
                DiagnosticCode.Compiling_constant_with_non_constant_initializer_as_mutable,
                valueDeclaration.range
              );
            }
            initInStart = true;
          }
          if (initInStart) {
            this.module.addGlobal(
              val.internalName,
              NativeType.I32,
              true, // mutable
              this.module.createI32(0)
            );
            this.startFunctionBody.push(this.module.createSetGlobal(val.internalName, initExpr));
          } else {
            this.module.addGlobal(val.internalName, NativeType.I32, false, initExpr);
            if (_BinaryenExpressionGetType(initExpr) == NativeType.I32) {
              val.constantValue = _BinaryenConstGetValueI32(initExpr);
              val.set(ElementFlags.INLINED);
            } else {
              throw new Error("i32 expected");
            }
          }
        }
        previousValue = <EnumValue>val;

        // export values if the enum is exported
        if (element.declaration.range.source.isEntry && element.declaration.isTopLevelExport) {
          if (member.is(ElementFlags.INLINED)) {
            this.module.addGlobalExport(member.internalName, member.internalName);
          } else if (valueDeclaration) {
            this.warning(
              DiagnosticCode.Cannot_export_a_mutable_global,
              valueDeclaration.range
            );
          }
        }
      }
    }
    this.currentEnum = null;
    return true;
  }

  // functions

  /** Compiles a function given its declaration. */
  compileFunctionDeclaration(
    declaration: FunctionDeclaration,
    typeArguments: TypeNode[],
    contextualTypeArguments: Map<string,Type> | null = null
  ): Function | null {
    var element = assert(this.program.elements.get(declaration.fileLevelInternalName));
    assert(element.kind == ElementKind.FUNCTION_PROTOTYPE);
    return this.compileFunctionUsingTypeArguments( // reports
      <FunctionPrototype>element,
      typeArguments,
      contextualTypeArguments,
      (<FunctionPrototype>element).declaration.name
    );
  }

  /** Resolves the specified type arguments prior to compiling the resulting function instance. */
  compileFunctionUsingTypeArguments(
    prototype: FunctionPrototype,
    typeArguments: TypeNode[],
    contextualTypeArguments: Map<string,Type> | null,
    reportNode: Node
  ): Function | null {
    var instance = prototype.resolveUsingTypeArguments( // reports
      typeArguments,
      contextualTypeArguments,
      reportNode
    );
    if (!(instance && this.compileFunction(instance))) return null;
    return instance;
  }

  /** Either reuses or creates the function type matching the specified signature. */
  private ensureFunctionType(signature: Signature): FunctionTypeRef {
    var parameters = signature.parameterTypes;
    var numParameters = parameters.length;
    var thisType = signature.thisType;
    var paramTypes: NativeType[];
    var index = 0;
    if (thisType) {
      paramTypes = new Array(1 + numParameters);
      paramTypes[0] = thisType.toNativeType();
      index = 1;
    } else {
      paramTypes = new Array(numParameters);
    }
    for (let i = 0; i < numParameters; ++i, ++index) {
      paramTypes[index] = signature.parameterTypes[i].toNativeType();
    }
    var resultType = signature.returnType.toNativeType();
    var typeRef = this.module.getFunctionTypeBySignature(resultType, paramTypes);
    if (!typeRef) {
      typeRef = this.module.addFunctionType(signature.toSignatureString(), resultType, paramTypes);
    }
    return typeRef;
  }

  /** Compiles a readily resolved function instance. */
  compileFunction(instance: Function): bool {
    if (instance.is(ElementFlags.COMPILED)) return true;
    assert(!instance.is(ElementFlags.BUILTIN) || instance.simpleName == "abort");
    instance.set(ElementFlags.COMPILED);

    // check that modifiers are matching but still compile as-is
    var declaration = instance.prototype.declaration;
    var body = declaration.body;
    if (body) {
      if (instance.is(ElementFlags.DECLARED)) {
        this.error(
          DiagnosticCode.An_implementation_cannot_be_declared_in_ambient_contexts,
          declaration.name.range
        );
      }
    } else {
      if (!instance.is(ElementFlags.DECLARED)) {
        this.error(
          DiagnosticCode.Function_implementation_is_missing_or_not_immediately_following_the_declaration,
          declaration.name.range
        );
      }
    }

    var ref: FunctionRef;
    var typeRef = this.ensureFunctionType(instance.signature);
    if (body) {

      // compile body
      let previousFunction = this.currentFunction;
      this.currentFunction = instance;
      let stmt = this.compileStatement(body);

      // make sure all branches return
      let allBranchesReturn = this.currentFunction.flow.finalize();
      let returnType = instance.signature.returnType;
      if (returnType != Type.void && !allBranchesReturn) {
        this.error(
          DiagnosticCode.A_function_whose_declared_type_is_not_void_must_return_a_value,
          assert(declaration.signature.returnType, "return type expected").range
        );
      }
      this.currentFunction = previousFunction;

      // create the function
      ref = this.module.addFunction(
        instance.internalName,
        typeRef,
        typesToNativeTypes(instance.additionalLocals),
        stmt
      );

    } else {
      instance.set(ElementFlags.IMPORTED);

      // create the function import
      let namespace = instance.prototype.namespace;
      ref = this.module.addFunctionImport(
        instance.internalName,
        namespace
          ? namespace.simpleName
          : "env",
        instance.simpleName,
        typeRef
      );
    }

    // check module-level export
    if (declaration.range.source.isEntry && declaration.isTopLevelExport) {
      this.module.addFunctionExport(instance.internalName, declaration.name.text);
    }

    instance.finalize(this.module, ref);
    return true;
  }

  // namespaces

  compileNamespaceDeclaration(declaration: NamespaceDeclaration): void {
    var members = declaration.members;
    var noTreeShaking = this.options.noTreeShaking;
    for (let i = 0, k = members.length; i < k; ++i) {
      let member = members[i];
      switch (member.kind) {
        case NodeKind.CLASSDECLARATION: {
          if (
            (
              noTreeShaking ||
              hasModifier(ModifierKind.EXPORT, (<ClassDeclaration>member).modifiers)
            ) && !(<ClassDeclaration>member).typeParameters.length
          ) {
            this.compileClassDeclaration(<ClassDeclaration>member, []);
          }
          break;
        }
        case NodeKind.INTERFACEDECLARATION: {
          if (
            (
              noTreeShaking ||
              hasModifier(ModifierKind.EXPORT, (<InterfaceDeclaration>member).modifiers)
            ) && !(<InterfaceDeclaration>member).typeParameters.length
          ) {
            this.compileInterfaceDeclaration(<InterfaceDeclaration>member, []);
          }
          break;
        }
        case NodeKind.ENUMDECLARATION: {
          if (
            noTreeShaking ||
            hasModifier(ModifierKind.EXPORT, (<EnumDeclaration>member).modifiers)
          ) {
            this.compileEnumDeclaration(<EnumDeclaration>member);
          }
          break;
        }
        case NodeKind.FUNCTIONDECLARATION: {
          if (
            (
              noTreeShaking ||
              hasModifier(ModifierKind.EXPORT, (<FunctionDeclaration>member).modifiers)
            ) &&
            !(<FunctionDeclaration>member).isGeneric
          ) {
            this.compileFunctionDeclaration(<FunctionDeclaration>member, []);
          }
          break;
        }
        case NodeKind.NAMESPACEDECLARATION: {
          if (
            noTreeShaking ||
            hasModifier(ModifierKind.EXPORT, (<NamespaceDeclaration>member).modifiers)
          ) {
            this.compileNamespaceDeclaration(<NamespaceDeclaration>member);
          }
          break;
        }
        case NodeKind.VARIABLE: {
          if (
            noTreeShaking ||
            hasModifier(ModifierKind.EXPORT, (<VariableStatement>member).modifiers)
          ) {
            let variableInit = this.compileVariableStatement(<VariableStatement>member, true);
            if (variableInit) this.startFunctionBody.push(variableInit);
          }
          break;
        }
        default: {
          throw new Error("namespace member expected");
        }
      }
    }
  }

  compileNamespace(ns: Namespace): void {
    if (!ns.members) return;

    var noTreeShaking = this.options.noTreeShaking;
    for (let element of ns.members.values()) {
      switch (element.kind) {
        case ElementKind.CLASS_PROTOTYPE: {
          if (
            (
              noTreeShaking ||
              (<ClassPrototype>element).is(ElementFlags.EXPORTED)
            ) && !(<ClassPrototype>element).is(ElementFlags.GENERIC)
          ) {
            this.compileClassUsingTypeArguments(<ClassPrototype>element, []);
          }
          break;
        }
        case ElementKind.ENUM: {
          this.compileEnum(<Enum>element);
          break;
        }
        case ElementKind.FUNCTION_PROTOTYPE: {
          if (
            (
              noTreeShaking || (<FunctionPrototype>element).is(ElementFlags.EXPORTED)
            ) && !(<FunctionPrototype>element).is(ElementFlags.GENERIC)
          ) {
            this.compileFunctionUsingTypeArguments(
              <FunctionPrototype>element,
              [],
              null,
              (<FunctionPrototype>element).declaration.name
            );
          }
          break;
        }
        case ElementKind.GLOBAL: {
          this.compileGlobal(<Global>element);
          break;
        }
        case ElementKind.NAMESPACE: {
          this.compileNamespace(<Namespace>element);
          break;
        }
      }
    }
  }

  // exports

  compileExportStatement(statement: ExportStatement): void {
    var members = statement.members;
    for (let i = 0, k = members.length; i < k; ++i) {
      let member = members[i];
      let internalExportName = (
        statement.range.source.internalPath +
        PATH_DELIMITER +
        member.externalName.text
      );
      let element = this.program.exports.get(internalExportName);
      if (!element) continue; // reported in Program#initialize

      switch (element.kind) {
        case ElementKind.CLASS_PROTOTYPE: {
          if (!(<ClassPrototype>element).is(ElementFlags.GENERIC)) {
            this.compileClassUsingTypeArguments(<ClassPrototype>element, []);
          }
          break;
        }
        case ElementKind.ENUM: {
          this.compileEnum(<Enum>element);
          break;
        }
        case ElementKind.FUNCTION_PROTOTYPE: {
          if (
            !(<FunctionPrototype>element).is(ElementFlags.GENERIC) &&
            statement.range.source.isEntry
          ) {
            let functionInstance = this.compileFunctionUsingTypeArguments(
              <FunctionPrototype>element,
              [],
              null,
              (<FunctionPrototype>element).declaration.name
            );
            if (functionInstance) {
              let functionDeclaration = functionInstance.prototype.declaration;
              if (functionDeclaration && functionDeclaration.needsExplicitExport(member)) {
                this.module.addFunctionExport(functionInstance.internalName, member.externalName.text);
              }
            }
          }
          break;
        }
        case ElementKind.GLOBAL: {
          if (this.compileGlobal(<Global>element) && statement.range.source.isEntry) {
            let globalDeclaration = (<Global>element).declaration;
            if (globalDeclaration && globalDeclaration.needsExplicitExport(member)) {
              if ((<Global>element).is(ElementFlags.INLINED)) {
                this.module.addGlobalExport(element.internalName, member.externalName.text);
              } else {
                this.warning(
                  DiagnosticCode.Cannot_export_a_mutable_global,
                  member.range
                );
              }
            }
          }
          break;
        }
        case ElementKind.NAMESPACE: {
          this.compileNamespace(<Namespace>element);
          break;
        }
      }
    }
  }

  // classes

  compileClassDeclaration(
    declaration: ClassDeclaration,
    typeArguments: TypeNode[],
    contextualTypeArguments: Map<string,Type> | null = null,
    alternativeReportNode: Node | null = null
  ): void {
    var element = this.program.elements.get(declaration.fileLevelInternalName);
    if (!element || element.kind != ElementKind.CLASS_PROTOTYPE) {
      throw new Error("class expected");
    }
    this.compileClassUsingTypeArguments(
      <ClassPrototype>element,
      typeArguments,
      contextualTypeArguments,
      alternativeReportNode
    );
  }

  compileClassUsingTypeArguments(
    prototype: ClassPrototype,
    typeArguments: TypeNode[],
    contextualTypeArguments: Map<string,Type> | null = null,
    alternativeReportNode: Node | null = null
  ): void {
    var instance = prototype.resolveUsingTypeArguments( // reports
      typeArguments,
      contextualTypeArguments,
      alternativeReportNode
    );
    if (!instance) return;
    this.compileClass(instance);
  }

  compileClass(instance: Class): bool {
    if (instance.is(ElementFlags.COMPILED)) return true;
    instance.set(ElementFlags.COMPILED);
    return true;
  }

  compileInterfaceDeclaration(
    declaration: InterfaceDeclaration,
    typeArguments: TypeNode[],
    contextualTypeArguments: Map<string,Type> | null = null,
    alternativeReportNode: Node | null = null
  ): void {
    throw new Error("not implemented");
  }

  // memory

  /** Adds a static memory segment with the specified data. */
  addMemorySegment(buffer: Uint8Array, alignment: i32 = 8): MemorySegment {
    var memoryOffset = i64_align(this.memoryOffset, alignment);
    var segment = MemorySegment.create(buffer, memoryOffset);
    this.memorySegments.push(segment);
    this.memoryOffset = i64_add(memoryOffset, i64_new(buffer.length, 0));
    return segment;
  }

  // function table

  /** Ensures that a table entry exists for the specified function and returns its index. */
  ensureFunctionTableEntry(func: Function): i32 {
    assert(func.is(ElementFlags.COMPILED));
    if (func.functionTableIndex >= 0) {
      return func.functionTableIndex;
    }
    var index = this.functionTable.length;
    this.functionTable.push(func);
    func.functionTableIndex = index;
    return index;
  }

  // statements

  compileStatement(statement: Statement): ExpressionRef {
    var expr: ExpressionRef;
    switch (statement.kind) {
      case NodeKind.BLOCK: {
        expr = this.compileBlockStatement(<BlockStatement>statement);
        break;
      }
      case NodeKind.BREAK: {
        expr = this.compileBreakStatement(<BreakStatement>statement);
        break;
      }
      case NodeKind.CONTINUE: {
        expr = this.compileContinueStatement(<ContinueStatement>statement);
        break;
      }
      case NodeKind.DO: {
        expr = this.compileDoStatement(<DoStatement>statement);
        break;
      }
      case NodeKind.EMPTY: {
        expr = this.compileEmptyStatement(<EmptyStatement>statement);
        break;
      }
      case NodeKind.EXPRESSION: {
        expr = this.compileExpressionStatement(<ExpressionStatement>statement);
        break;
      }
      case NodeKind.FOR: {
        expr = this.compileForStatement(<ForStatement>statement);
        break;
      }
      case NodeKind.IF: {
        expr = this.compileIfStatement(<IfStatement>statement);
        break;
      }
      case NodeKind.RETURN: {
        expr = this.compileReturnStatement(<ReturnStatement>statement);
        break;
      }
      case NodeKind.SWITCH: {
        expr = this.compileSwitchStatement(<SwitchStatement>statement);
        break;
      }
      case NodeKind.THROW: {
        expr = this.compileThrowStatement(<ThrowStatement>statement);
        break;
      }
      case NodeKind.TRY: {
        expr = this.compileTryStatement(<TryStatement>statement);
        break;
      }
      case NodeKind.VARIABLE: {
        expr = this.compileVariableStatement(<VariableStatement>statement);
        if (!expr) expr = this.module.createNop();
        break;
      }
      case NodeKind.VOID: {
        expr = this.compileVoidStatement(<VoidStatement>statement);
        break;
      }
      case NodeKind.WHILE: {
        expr = this.compileWhileStatement(<WhileStatement>statement);
        break;
      }
      case NodeKind.TYPEDECLARATION: {
        // type declarations must be top-level because function bodies are evaluated when
        // reachaable only.
        if (this.currentFunction == this.startFunction) {
          return this.module.createNop();
        }
        // otherwise fall-through
      }
      default: {
        throw new Error("statement expected");
      }
    }
    this.addDebugLocation(expr, statement.range);
    return expr;
  }

  compileStatements(statements: Statement[]): ExpressionRef[] {
    var numStatements = statements.length;
    var stmts = new Array<ExpressionRef>(numStatements);
    for (let i = 0; i < numStatements; ++i) {
      stmts[i] = this.compileStatement(statements[i]);
    }
    return stmts; // array of 0-es in noEmit-mode
  }

  compileBlockStatement(statement: BlockStatement): ExpressionRef {
    var statements = statement.statements;

    // NOTE that we could optimize this to a NOP if empty or unwrap a single
    // statement, but that's not what the source told us to do and left to the
    // optimizer.

    // Not actually a branch, but can contain its own scoped variables.
    this.currentFunction.flow = this.currentFunction.flow.enterBranchOrScope();

    var stmt = this.module.createBlock(null, this.compileStatements(statements), NativeType.None);
    var stmtReturns = this.currentFunction.flow.is(FlowFlags.RETURNS);

    // Switch back to the parent flow
    this.currentFunction.flow = this.currentFunction.flow.leaveBranchOrScope();
    if (stmtReturns) {
      this.currentFunction.flow.set(FlowFlags.RETURNS);
    }
    return stmt;
  }

  compileBreakStatement(statement: BreakStatement): ExpressionRef {
    if (statement.label) {
      this.error(
        DiagnosticCode.Operation_not_supported,
        statement.label.range
      );
      return this.module.createUnreachable();
    }
    var breakLabel = this.currentFunction.flow.breakLabel;
    if (breakLabel == null) {
      this.error(
        DiagnosticCode.A_break_statement_can_only_be_used_within_an_enclosing_iteration_or_switch_statement,
        statement.range
      );
      return this.module.createUnreachable();
    }
    this.currentFunction.flow.set(FlowFlags.POSSIBLY_BREAKS);
    return this.module.createBreak(breakLabel);
  }

  compileContinueStatement(statement: ContinueStatement): ExpressionRef {
    if (statement.label) {
      this.error(
        DiagnosticCode.Operation_not_supported,
        statement.label.range
      );
      return this.module.createUnreachable();
    }
    // Check if 'continue' is allowed here
    var continueLabel = this.currentFunction.flow.continueLabel;
    if (continueLabel == null) {
      this.error(
        DiagnosticCode.A_continue_statement_can_only_be_used_within_an_enclosing_iteration_statement,
        statement.range
      );
      return this.module.createUnreachable();
    }
    this.currentFunction.flow.set(FlowFlags.POSSIBLY_CONTINUES);
    return this.module.createBreak(continueLabel);
  }

  compileDoStatement(statement: DoStatement): ExpressionRef {

    // A do statement does not initiate a new branch because it is executed at
    // least once, but has its own break and continue labels.
    var label = this.currentFunction.enterBreakContext();
    var previousBreakLabel = this.currentFunction.flow.breakLabel;
    var previousContinueLabel = this.currentFunction.flow.continueLabel;
    var breakLabel = this.currentFunction.flow.breakLabel = "break|" + label;
    var continueLabel = this.currentFunction.flow.continueLabel = "continue|" + label;

    var body = this.compileStatement(statement.statement);

    // Reset to the previous break and continue labels, if any.
    this.currentFunction.flow.breakLabel = previousBreakLabel;
    this.currentFunction.flow.continueLabel = previousContinueLabel;

    var condition = makeIsTrueish(
      this.compileExpression(statement.condition, Type.i32, ConversionKind.NONE),
      this.currentType,
      this.module
    );

    this.currentFunction.leaveBreakContext();

    return this.module.createBlock(breakLabel, [
      this.module.createLoop(continueLabel,
        this.module.createBlock(null, [
          body,
          this.module.createBreak(continueLabel, condition)
        ], NativeType.None))
    ], NativeType.None);
  }

  compileEmptyStatement(statement: EmptyStatement): ExpressionRef {
    return this.module.createNop();
  }

  compileExpressionStatement(statement: ExpressionStatement): ExpressionRef {
    var expr = this.compileExpression(statement.expression, Type.void, ConversionKind.NONE);
    if (this.currentType != Type.void) {
      expr = this.module.createDrop(expr);
      this.currentType = Type.void;
    }
    return expr;
  }

  compileForStatement(statement: ForStatement): ExpressionRef {

    // A for statement initiates a new branch with its own scoped variables
    // possibly declared in its initializer, and break context.
    var context = this.currentFunction.enterBreakContext();
    this.currentFunction.flow = this.currentFunction.flow.enterBranchOrScope();
    var breakLabel = this.currentFunction.flow.breakLabel = "break|" + context;
    var continueLabel = this.currentFunction.flow.continueLabel = "continue|" + context;

    // Compile in correct order
    var initializer = statement.initializer
      ? this.compileStatement(<Statement>statement.initializer)
      : this.module.createNop();
    var condition = statement.condition
      ? this.compileExpression(<Expression>statement.condition, Type.i32)
      : this.module.createI32(1);
    var incrementor = statement.incrementor
      ? this.compileExpression(<Expression>statement.incrementor, Type.void)
      : this.module.createNop();
    var body = this.compileStatement(statement.statement);
    var alwaysReturns = !statement.condition && this.currentFunction.flow.is(FlowFlags.RETURNS);
    // TODO: check other always-true conditions as well, not just omitted

    // Switch back to the parent flow
    this.currentFunction.flow = this.currentFunction.flow.leaveBranchOrScope();
    this.currentFunction.leaveBreakContext();

    var expr = this.module.createBlock(breakLabel, [
      initializer,
      this.module.createLoop(continueLabel, this.module.createBlock(null, [
        this.module.createIf(condition, this.module.createBlock(null, [
          body,
          incrementor,
          this.module.createBreak(continueLabel)
        ], NativeType.None))
      ], NativeType.None))
    ], NativeType.None);

    // If the loop is guaranteed to run and return, propagate that and append a hint
    if (alwaysReturns) {
      this.currentFunction.flow.set(FlowFlags.RETURNS);
      expr = this.module.createBlock(null, [
        expr,
        this.module.createUnreachable()
      ]);
    }
    return expr;
  }

  compileIfStatement(statement: IfStatement): ExpressionRef {

    // The condition doesn't initiate a branch yet
    var condition = makeIsTrueish(
      this.compileExpression(statement.condition, Type.i32, ConversionKind.NONE),
      this.currentType,
      this.module
    );

    // Each arm initiates a branch
    this.currentFunction.flow = this.currentFunction.flow.enterBranchOrScope();
    var ifTrue = this.compileStatement(statement.ifTrue);
    var ifTrueReturns = this.currentFunction.flow.is(FlowFlags.RETURNS);
    this.currentFunction.flow = this.currentFunction.flow.leaveBranchOrScope();

    var ifFalse: ExpressionRef = 0;
    var ifFalseReturns = false;
    if (statement.ifFalse) {
      this.currentFunction.flow = this.currentFunction.flow.enterBranchOrScope();
      ifFalse = this.compileStatement(statement.ifFalse);
      ifFalseReturns = this.currentFunction.flow.is(FlowFlags.RETURNS);
      this.currentFunction.flow = this.currentFunction.flow.leaveBranchOrScope();
    }
    if (ifTrueReturns && ifFalseReturns) { // not necessary to append a hint
      this.currentFunction.flow.set(FlowFlags.RETURNS);
    }
    return this.module.createIf(condition, ifTrue, ifFalse);
  }

  compileReturnStatement(statement: ReturnStatement): ExpressionRef {
    var expression: ExpressionRef = 0;
    if (statement.value) {
      expression = this.compileExpression(
        statement.value,
        this.currentFunction.signature.returnType
      );
    }

    // Remember that this flow returns
    this.currentFunction.flow.set(FlowFlags.RETURNS);

    return this.module.createReturn(expression);
  }

  compileSwitchStatement(statement: SwitchStatement): ExpressionRef {

    // Everything within a switch uses the same break context
    var context = this.currentFunction.enterBreakContext();

    // introduce a local for evaluating the condition (exactly once)
    var tempLocal = this.currentFunction.getTempLocal(Type.u32);
    var numCases = statement.cases.length;

    // Prepend initializer to inner block. Does not initiate a new branch, yet.
    var breaks = new Array<ExpressionRef>(1 + numCases);
    breaks[0] = this.module.createSetLocal( // initializer
      tempLocal.index,
      this.compileExpression(statement.condition, Type.u32)
    );

    // make one br_if per (possibly dynamic) labeled case (binaryen optimizes to br_table where possible)
    var breakIndex = 1;
    var defaultIndex = -1;
    for (let i = 0; i < numCases; ++i) {
      let case_ = statement.cases[i];
      if (case_.label) {
        breaks[breakIndex++] = this.module.createBreak("case" + i.toString(10) + "|" + context,
          this.module.createBinary(BinaryOp.EqI32,
            this.module.createGetLocal(tempLocal.index, NativeType.I32),
            this.compileExpression(case_.label, Type.i32)
          )
        );
      } else {
        defaultIndex = i;
      }
    }

    this.currentFunction.freeTempLocal(tempLocal);

    // otherwise br to default respectively out of the switch if there is no default case
    breaks[breakIndex] = this.module.createBreak((defaultIndex >= 0
        ? "case" + defaultIndex.toString(10)
        : "break"
      ) + "|" + context);

    // nest blocks in order
    var currentBlock = this.module.createBlock("case0|" + context, breaks, NativeType.None);
    var alwaysReturns = true;
    for (let i = 0; i < numCases; ++i) {
      let case_ = statement.cases[i];
      let l = case_.statements.length;
      let body = new Array<ExpressionRef>(1 + l);
      body[0] = currentBlock;

      // Each switch case initiates a new branch
      this.currentFunction.flow = this.currentFunction.flow.enterBranchOrScope();
      let breakLabel = this.currentFunction.flow.breakLabel = "break|" + context;

      let fallsThrough = i != numCases - 1;
      let nextLabel = !fallsThrough ? breakLabel : "case" + (i + 1).toString(10) + "|" + context;
      for (let j = 0; j < l; ++j) {
        body[j + 1] = this.compileStatement(case_.statements[j]);
      }
      if (!(fallsThrough || this.currentFunction.flow.is(FlowFlags.RETURNS))) {
        alwaysReturns = false; // ignore fall-throughs
      }

      // Switch back to the parent flow
      this.currentFunction.flow = this.currentFunction.flow.leaveBranchOrScope();

      currentBlock = this.module.createBlock(nextLabel, body, NativeType.None);
    }
    this.currentFunction.leaveBreakContext();

    // If the switch has a default and always returns, propagate that
    if (defaultIndex >= 0 && alwaysReturns) {
      this.currentFunction.flow.set(FlowFlags.RETURNS);
      // Binaryen understands that so we don't need a hint
    }
    return currentBlock;
  }

  compileThrowStatement(statement: ThrowStatement): ExpressionRef {

    // Remember that this branch possibly throws
    this.currentFunction.flow.set(FlowFlags.POSSIBLY_THROWS);

    // FIXME: without try-catch it is safe to assume RETURNS as well for now
    this.currentFunction.flow.set(FlowFlags.RETURNS);

    // TODO: requires exception-handling spec.
    return this.module.createUnreachable();
  }

  compileTryStatement(statement: TryStatement): ExpressionRef {
    throw new Error("not implemented");
    // can't yet support something like: try { return ... } finally { ... }
    // worthwhile to investigate lowering returns to block results (here)?
  }

  /**
   * Compiles a variable statement. Returns `0` if an initializer is not
   * necessary.
   */
  compileVariableStatement(statement: VariableStatement, isKnownGlobal: bool = false): ExpressionRef {
    var declarations = statement.declarations;
    var numDeclarations = declarations.length;

    // top-level variables and constants become globals
    if (isKnownGlobal || (
      this.currentFunction == this.startFunction &&
      statement.parent && statement.parent.kind == NodeKind.SOURCE
    )) {
      // NOTE that the above condition also covers top-level variables declared with 'let', even
      // though such variables could also become start function locals if, and only if, not used
      // within any function declared in the same source, which is unknown at this point. the only
      // efficient way to deal with this would be to keep track of all occasions it is used and
      // replace these instructions afterwards, dynamically. (TOOD: what about a Binaryen pass?)
      for (let i = 0; i < numDeclarations; ++i) {
        this.compileGlobalDeclaration(declarations[i]);
      }
      return 0;
    }

    // other variables become locals
    var initializers = new Array<ExpressionRef>();
    for (let i = 0; i < numDeclarations; ++i) {
      let declaration = declarations[i];
      let name = declaration.name.text;
      let type: Type | null = null;
      let init: ExpressionRef = 0;
      if (declaration.type) {
        type = this.program.resolveType( // reports
          declaration.type,
          this.currentFunction.contextualTypeArguments
        );
        if (!type) continue;
        if (declaration.initializer) {
          init = this.compileExpression(declaration.initializer, type); // reports
        }
      } else if (declaration.initializer) { // infer type using void/NONE for proper literal inference
        init = this.compileExpression( // reports
          declaration.initializer,
          Type.void,
          ConversionKind.NONE
        );
        if (this.currentType == Type.void) {
          this.error(
            DiagnosticCode.Type_0_is_not_assignable_to_type_1,
            declaration.range, this.currentType.toString(), "<auto>"
          );
          continue;
        }
        type = this.currentType;
      } else {
        this.error(
          DiagnosticCode.Type_expected,
          declaration.name.range.atEnd
        );
        continue;
      }
      if (hasModifier(ModifierKind.CONST, declaration.modifiers)) {
        if (init) {
          init = this.precomputeExpressionRef(init);
          if (_BinaryenExpressionGetId(init) == ExpressionId.Const) {
            let local = new Local(this.program, name, -1, type);
            switch (_BinaryenExpressionGetType(init)) {
              case NativeType.I32: {
                local = local.withConstantIntegerValue(_BinaryenConstGetValueI32(init), 0);
                break;
              }
              case NativeType.I64: {
                local = local.withConstantIntegerValue(
                  _BinaryenConstGetValueI64Low(init),
                  _BinaryenConstGetValueI64High(init)
                );
                break;
              }
              case NativeType.F32: {
                local = local.withConstantFloatValue(<f64>_BinaryenConstGetValueF32(init));
                break;
              }
              case NativeType.F64: {
                local = local.withConstantFloatValue(_BinaryenConstGetValueF64(init));
                break;
              }
              default: {
                throw new Error("concrete type expected");
              }
            }
            // Create a virtual local that doesn't actually exist in WebAssembly
            let scopedLocals = this.currentFunction.flow.scopedLocals;
            if (!scopedLocals) scopedLocals = this.currentFunction.flow.scopedLocals = new Map();
            else if (scopedLocals.has(name)) {
              this.error(
                DiagnosticCode.Duplicate_identifier_0,
                declaration.name.range, name
              );
              return 0;
            }
            scopedLocals.set(name, local);
            return 0;
          } else {
            this.warning(
              DiagnosticCode.Compiling_constant_with_non_constant_initializer_as_mutable,
              declaration.range
            );
          }
        } else {
          this.error(
            DiagnosticCode._const_declarations_must_be_initialized,
            declaration.range
          );
        }
      }
      if (hasModifier(ModifierKind.LET, declaration.modifiers)) { // here: not top-level
        this.currentFunction.flow.addScopedLocal(name, type, declaration.name); // reports
      } else {
        this.currentFunction.addLocal(type, name); // reports
      }
      if (init) {
        initializers.push(this.compileAssignmentWithValue(declaration.name, init));
      }
    }
    return initializers.length   // we can unwrap these here because the
      ? initializers.length == 1 // source didn't tell us exactly what to do
        ? initializers[0]
        : this.module.createBlock(null, initializers, NativeType.None)
      : 0;
  }

  compileVoidStatement(statement: VoidStatement): ExpressionRef {
    return this.compileExpression(statement.expression, Type.void, ConversionKind.EXPLICIT, false);
  }

  compileWhileStatement(statement: WhileStatement): ExpressionRef {

    // The condition does not yet initialize a branch
    var condition = makeIsTrueish(
      this.compileExpression(statement.condition, Type.i32, ConversionKind.NONE),
      this.currentType,
      this.module
    );

    // Statements initiate a new branch with its own break context
    var label = this.currentFunction.enterBreakContext();
    this.currentFunction.flow = this.currentFunction.flow.enterBranchOrScope();
    var breakLabel = this.currentFunction.flow.breakLabel = "break|" + label;
    var continueLabel = this.currentFunction.flow.continueLabel = "continue|" + label;

    var body = this.compileStatement(statement.statement);
    var alwaysReturns = false && this.currentFunction.flow.is(FlowFlags.RETURNS);
    // TODO: evaluate possible always-true conditions

    // Switch back to the parent flow
    this.currentFunction.flow = this.currentFunction.flow.leaveBranchOrScope();
    this.currentFunction.leaveBreakContext();

    var expr = this.module.createBlock(breakLabel, [
      this.module.createLoop(continueLabel,
        this.module.createIf(condition, this.module.createBlock(null, [
          body,
          this.module.createBreak(continueLabel)
        ], NativeType.None))
      )
    ], NativeType.None);

    // If the loop is guaranteed to run and return, propagate that and append a hint
    if (alwaysReturns) {
      expr = this.module.createBlock(null, [
        expr,
        this.module.createUnreachable()
      ]);
    }
    return expr;
  }

  // expressions

  /**
   * Compiles the value of an inlined constant element.
   * @param retainType If true, the annotated type of the constant is retained. Otherwise, the value
   *  is precomputed according to context.
   */
  compileInlineConstant(
    element: VariableLikeElement,
    contextualType: Type,
    retainType: bool
  ): ExpressionRef {
    assert(element.is(ElementFlags.INLINED));
    switch (
      !retainType &&
      element.type.is(TypeFlags.INTEGER) &&
      contextualType.is(TypeFlags.INTEGER) &&
      element.type.size < contextualType.size
        ? (this.currentType = contextualType).kind // essentially precomputes a (sign-)extension
        : (this.currentType = element.type).kind
    ) {
      case TypeKind.I8:
      case TypeKind.I16: {
        let shift = element.type.computeSmallIntegerShift(Type.i32);
        return this.module.createI32(
          element.constantValueKind == ConstantValueKind.INTEGER
            ? i64_low(element.constantIntegerValue) << shift >> shift
            : 0
        );
      }
      case TypeKind.U8:
      case TypeKind.U16:
      case TypeKind.BOOL: {
        let mask = element.type.computeSmallIntegerMask(Type.i32);
        return this.module.createI32(
          element.constantValueKind == ConstantValueKind.INTEGER
            ? i64_low(element.constantIntegerValue) & mask
            : 0
        );
      }
      case TypeKind.I32:
      case TypeKind.U32: {
        return this.module.createI32(
          element.constantValueKind == ConstantValueKind.INTEGER
            ? i64_low(element.constantIntegerValue)
            : 0
        );
      }
      case TypeKind.ISIZE:
      case TypeKind.USIZE: {
        if (!element.program.options.isWasm64) {
          return this.module.createI32(
            element.constantValueKind == ConstantValueKind.INTEGER
              ? i64_low(element.constantIntegerValue)
              : 0
          );
        }
        // fall-through
      }
      case TypeKind.I64:
      case TypeKind.U64: {
        return element.constantValueKind == ConstantValueKind.INTEGER
          ? this.module.createI64(
              i64_low(element.constantIntegerValue),
              i64_high(element.constantIntegerValue)
            )
          : this.module.createI64(0);
      }
      case TypeKind.F32: {
        return this.module.createF32((<VariableLikeElement>element).constantFloatValue);
      }
      case TypeKind.F64: {
        return this.module.createF64((<VariableLikeElement>element).constantFloatValue);
      }
      default: {
        throw new Error("concrete type expected");
      }
    }
  }

  compileExpression(
    expression: Expression,
    contextualType: Type,
    conversionKind: ConversionKind = ConversionKind.IMPLICIT,
    wrapSmallIntegers: bool = true
  ): ExpressionRef {
    this.currentType = contextualType;

    var expr: ExpressionRef;
    switch (expression.kind) {
      case NodeKind.ASSERTION: {
        expr = this.compileAssertionExpression(<AssertionExpression>expression, contextualType);
        break;
      }
      case NodeKind.BINARY: {
        expr = this.compileBinaryExpression(<BinaryExpression>expression, contextualType, wrapSmallIntegers);
        break;
      }
      case NodeKind.CALL: {
        expr = this.compileCallExpression(<CallExpression>expression, contextualType);
        break;
      }
      case NodeKind.COMMA: {
        expr = this.compileCommaExpression(<CommaExpression>expression, contextualType);
        break;
      }
      case NodeKind.ELEMENTACCESS: {
        expr = this.compileElementAccessExpression(<ElementAccessExpression>expression, contextualType);
        break;
      }
      case NodeKind.FUNCTION:
      case NodeKind.FUNCTIONARROW: {
        expr = this.compileFunctionExpression(<FunctionExpression>expression, contextualType);
        break;
      }
      case NodeKind.IDENTIFIER:
      case NodeKind.FALSE:
      case NodeKind.NULL:
      case NodeKind.THIS:
      case NodeKind.TRUE: {
        expr = this.compileIdentifierExpression(
          <IdentifierExpression>expression,
          contextualType,
          conversionKind == ConversionKind.NONE // retain type of inlined constants
        );
        break;
      }
      case NodeKind.LITERAL: {
        expr = this.compileLiteralExpression(<LiteralExpression>expression, contextualType);
        break;
      }
      case NodeKind.NEW: {
        expr = this.compileNewExpression(<NewExpression>expression, contextualType);
        break;
      }
      case NodeKind.PARENTHESIZED: {
        expr = this.compileParenthesizedExpression(
          <ParenthesizedExpression>expression,
          contextualType,
          wrapSmallIntegers
        );
        break;
      }
      case NodeKind.PROPERTYACCESS: {
        expr = this.compilePropertyAccessExpression(
          <PropertyAccessExpression>expression,
          contextualType,
          conversionKind == ConversionKind.NONE // retain type of inlined constants
        );
        break;
      }
      case NodeKind.TERNARY: {
        expr = this.compileTernaryExpression(<TernaryExpression>expression, contextualType);
        break;
      }
      case NodeKind.UNARYPOSTFIX: {
        expr = this.compileUnaryPostfixExpression(<UnaryPostfixExpression>expression, contextualType);
        break;
      }
      case NodeKind.UNARYPREFIX: {
        expr = this.compileUnaryPrefixExpression(<UnaryPrefixExpression>expression, contextualType, wrapSmallIntegers);
        break;
      }
      default: {
        throw new Error("expression expected");
      }
    }

    if (conversionKind != ConversionKind.NONE && this.currentType != contextualType) {
      expr = this.convertExpression(expr, this.currentType, contextualType, conversionKind, expression);
      this.currentType = contextualType;
    }

    this.addDebugLocation(expr, expression.range);
    return expr;
  }

  compileExpressionRetainType(expression: Expression, contextualType: Type, wrapSmallIntegers: bool = true) {
    return this.compileExpression(
      expression,
      contextualType == Type.void
        ? Type.i32
        : contextualType,
      ConversionKind.NONE,
      wrapSmallIntegers
    );
  }

  precomputeExpression(
    expression: Expression,
    contextualType: Type,
    conversionKind: ConversionKind = ConversionKind.IMPLICIT
  ): ExpressionRef {
    return this.precomputeExpressionRef(this.compileExpression(expression, contextualType, conversionKind));
  }

  precomputeExpressionRef(expr: ExpressionRef): ExpressionRef {
    var nativeType = this.currentType.toNativeType();
    var typeRef = this.module.getFunctionTypeBySignature(nativeType, null);
    var typeRefAdded = false;
    if (!typeRef) {
      typeRef = this.module.addFunctionType(this.currentType.toSignatureString(), nativeType, null);
      typeRefAdded = true;
    }
    var funcRef = this.module.addFunction("__precompute", typeRef, null, expr);
    this.module.runPasses([ "precompute" ], funcRef);
    var ret = _BinaryenFunctionGetBody(funcRef);
    this.module.removeFunction("__precompute");
    if (typeRefAdded) {
      // TODO: also remove the function type somehow if no longer used or make the C-API accept
      // a `null` typeRef, using an implicit type.
    }
    return ret;
  }

  convertExpression(
    expr: ExpressionRef,
    fromType: Type,
    toType: Type,
    conversionKind: ConversionKind,
    reportNode: Node
  ): ExpressionRef {
    if (conversionKind == ConversionKind.NONE) {
      assert(false, "concrete type expected");
      return expr;
    }

    // void to any
    if (fromType.kind == TypeKind.VOID) {
      this.error(
        DiagnosticCode.Type_0_is_not_assignable_to_type_1,
        reportNode.range, fromType.toString(), toType.toString()
      );
      return this.module.createUnreachable();
    }

    // any to void
    if (toType.kind == TypeKind.VOID) {
      return this.module.createDrop(expr);
    }

    if (conversionKind == ConversionKind.IMPLICIT && !fromType.isAssignableTo(toType)) {
      this.error(
        DiagnosticCode.Conversion_from_type_0_to_1_requires_an_explicit_cast,
        reportNode.range, fromType.toString(), toType.toString()
      );
    }

    if (fromType.is(TypeFlags.FLOAT)) {

      // float to float
      if (toType.is(TypeFlags.FLOAT)) {
        if (fromType.kind == TypeKind.F32) {

          // f32 to f64
          if (toType.kind == TypeKind.F64) {
            expr = this.module.createUnary(UnaryOp.PromoteF32, expr);
          }

          // otherwise f32 to f32

        // f64 to f32
        } else if (toType.kind == TypeKind.F32) {
          expr = this.module.createUnary(UnaryOp.DemoteF64, expr);
        }

        // otherwise f64 to f64

      // float to int
      } else if (toType.is(TypeFlags.INTEGER)) {

        // f32 to int
        if (fromType.kind == TypeKind.F32) {
          if (toType.is(TypeFlags.SIGNED)) {
            if (toType.is(TypeFlags.LONG)) {
              expr = this.module.createUnary(UnaryOp.TruncF32ToI64, expr);
            } else {
              expr = this.module.createUnary(UnaryOp.TruncF32ToI32, expr);
              if (toType.is(TypeFlags.SMALL)) {
                expr = makeSmallIntegerWrap(expr, toType, this.module);
              }
            }
          } else {
            if (toType.is(TypeFlags.LONG)) {
              expr = this.module.createUnary(UnaryOp.TruncF32ToU64, expr);
            } else {
              expr = this.module.createUnary(UnaryOp.TruncF32ToU32, expr);
              if (toType.is(TypeFlags.SMALL)) {
                expr = makeSmallIntegerWrap(expr, toType, this.module);
              }
            }
          }

        // f64 to int
        } else {
          if (toType.is(TypeFlags.SIGNED)) {
            if (toType.is(TypeFlags.LONG)) {
              expr = this.module.createUnary(UnaryOp.TruncF64ToI64, expr);
            } else {
              expr = this.module.createUnary(UnaryOp.TruncF64ToI32, expr);
              if (toType.is(TypeFlags.SMALL)) {
                expr = makeSmallIntegerWrap(expr, toType, this.module);
              }
            }
          } else {
            if (toType.is(TypeFlags.LONG)) {
              expr = this.module.createUnary(UnaryOp.TruncF64ToU64, expr);
            } else {
              expr = this.module.createUnary(UnaryOp.TruncF64ToU32, expr);
              if (toType.is(TypeFlags.SMALL)) {
                expr = makeSmallIntegerWrap(expr, toType, this.module);
              }
            }
          }
        }

      // float to void
      } else {
        assert(toType.flags == TypeFlags.NONE, "void type expected");
        expr = this.module.createDrop(expr);
      }

    // int to float
    } else if (fromType.is(TypeFlags.INTEGER) && toType.is(TypeFlags.FLOAT)) {

      // int to f32
      if (toType.kind == TypeKind.F32) {
        if (fromType.is(TypeFlags.LONG)) {
          expr = this.module.createUnary(
            fromType.is(TypeFlags.SIGNED)
              ? UnaryOp.ConvertI64ToF32
              : UnaryOp.ConvertU64ToF32,
            expr
          );
        } else {
          expr = this.module.createUnary(
            fromType.is(TypeFlags.SIGNED)
              ? UnaryOp.ConvertI32ToF32
              : UnaryOp.ConvertU32ToF32,
            expr
          );
        }

      // int to f64
      } else {
        if (fromType.is(TypeFlags.LONG)) {
          expr = this.module.createUnary(
            fromType.is(TypeFlags.SIGNED)
              ? UnaryOp.ConvertI64ToF64
              : UnaryOp.ConvertU64ToF64,
            expr
          );
        } else {
          expr = this.module.createUnary(
            fromType.is(TypeFlags.SIGNED)
              ? UnaryOp.ConvertI32ToF64
              : UnaryOp.ConvertU32ToF64,
            expr
          );
        }
      }

    // int to int
    } else {
      if (fromType.is(TypeFlags.LONG)) {

        // i64 to i32
        if (!toType.is(TypeFlags.LONG)) {
          expr = this.module.createUnary(UnaryOp.WrapI64, expr); // discards upper bits
          if (toType.is(TypeFlags.SMALL)) {
            expr = makeSmallIntegerWrap(expr, toType, this.module);
          }
        }

      // i32 to i64
      } else if (toType.is(TypeFlags.LONG)) {
        expr = this.module.createUnary(toType.is(TypeFlags.SIGNED) ? UnaryOp.ExtendI32 : UnaryOp.ExtendU32, expr);

      // i32 or smaller to even smaller or same size int with change of sign
      } else if (
        toType.is(TypeFlags.SMALL) &&
        (
          fromType.size > toType.size ||
          (
            fromType.size == toType.size &&
            fromType.is(TypeFlags.SIGNED) != toType.is(TypeFlags.SIGNED)
          )
        )
      ) {
        expr = makeSmallIntegerWrap(expr, toType, this.module);
      }

      // otherwise (smaller) i32/u32 to (same size) i32/u32
    }

    this.currentType = toType;
    return expr;
  }

  compileAssertionExpression(expression: AssertionExpression, contextualType: Type): ExpressionRef {
    var toType = this.program.resolveType( // reports
      expression.toType,
      this.currentFunction.contextualTypeArguments
    );
    if (!toType) return this.module.createUnreachable();
    return this.compileExpression(expression.expression, toType, ConversionKind.EXPLICIT);
  }

  compileBinaryExpression(
    expression: BinaryExpression,
    contextualType: Type,
    wrapSmallIntegers: bool = true
  ): ExpressionRef {

    var left: ExpressionRef;
    var leftType: Type;
    var right: ExpressionRef;
    var rightType: Type;
    var commonType: Type | null;

    var condition: ExpressionRef;
    var expr: ExpressionRef;
    var compound = false;
    var possiblyOverflows = false;
    var tempLocal: Local | null = null;

    switch (expression.operator) {
      case Token.LESSTHAN: {
        left = this.compileExpressionRetainType(expression.left, contextualType);
        leftType = this.currentType;
        right = this.compileExpressionRetainType(expression.right, leftType);
        rightType = this.currentType;
        if (commonType = Type.commonCompatible(leftType, rightType, true)) {
          left = this.convertExpression(left, leftType, commonType, ConversionKind.IMPLICIT, expression.left);
          right = this.convertExpression(right, rightType, commonType, ConversionKind.IMPLICIT, expression.right);
        } else {
          this.error(
            DiagnosticCode.Operator_0_cannot_be_applied_to_types_1_and_2,
            expression.range, "<", leftType.toString(), rightType.toString()
          );
          this.currentType = contextualType;
          return this.module.createUnreachable();
        }
        switch (commonType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.I32: {
            expr = this.module.createBinary(BinaryOp.LtI32, left, right);
            break;
          }
          case TypeKind.I64: {
            expr = this.module.createBinary(BinaryOp.LtI64, left, right);
            break;
          }
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.LtI64
                : BinaryOp.LtI32,
              left,
              right
            );
            break;
          }
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.U32:
          case TypeKind.BOOL: {
            expr = this.module.createBinary(BinaryOp.LtU32, left, right);
            break;
          }
          case TypeKind.USIZE: { // TODO: check operator overload
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.LtU64
                : BinaryOp.LtU32,
              left,
              right
            );
            break;
          }
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.LtU64, left, right);
            break;
          }
          case TypeKind.F32: {
            expr = this.module.createBinary(BinaryOp.LtF32, left, right);
            break;
          }
          case TypeKind.F64: {
            expr = this.module.createBinary(BinaryOp.LtF64, left, right);
            break;
          }
          default: {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            throw new Error("concrete type expected");
          }
        }
        this.currentType = Type.bool;
        break;
      }
      case Token.GREATERTHAN: {
        left = this.compileExpressionRetainType(expression.left, contextualType);
        leftType = this.currentType;
        right = this.compileExpressionRetainType(expression.right, leftType);
        rightType = this.currentType;
        if (commonType = Type.commonCompatible(leftType, rightType, true)) {
          left = this.convertExpression(left, leftType, commonType, ConversionKind.IMPLICIT, expression.left);
          right = this.convertExpression(right, rightType, commonType, ConversionKind.IMPLICIT, expression.right);
        } else {
          this.error(
            DiagnosticCode.Operator_0_cannot_be_applied_to_types_1_and_2,
            expression.range, ">", leftType.toString(), rightType.toString()
          );
          this.currentType = contextualType;
          return this.module.createUnreachable();
        }
        switch (commonType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.I32: {
            expr = this.module.createBinary(BinaryOp.GtI32, left, right);
            break;
          }
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.GtI64
                : BinaryOp.GtI32,
              left,
              right
            );
            break;
          }
          case TypeKind.I64: {
            expr = this.module.createBinary(BinaryOp.GtI64, left, right);
            break;
          }
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.U32:
          case TypeKind.BOOL: {
            expr = this.module.createBinary(BinaryOp.GtU32, left, right);
            break;
          }
          case TypeKind.USIZE: { // TODO: check operator overload
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.GtU64
                : BinaryOp.GtU32,
              left,
              right
            );
            break;
          }
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.GtU64, left, right);
            break;
          }
          case TypeKind.F32: {
            expr = this.module.createBinary(BinaryOp.GtF32, left, right);
            break;
          }
          case TypeKind.F64: {
            expr = this.module.createBinary(BinaryOp.GtF64, left, right);
            break;
          }
          default: {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            throw new Error("concrete type expected");
          }
        }
        this.currentType = Type.bool;
        break;
      }
      case Token.LESSTHAN_EQUALS: {
        left = this.compileExpressionRetainType(expression.left, contextualType);
        leftType = this.currentType;
        right = this.compileExpressionRetainType(expression.right, leftType);
        rightType = this.currentType;
        if (commonType = Type.commonCompatible(leftType, rightType, true)) {
          left = this.convertExpression(left, leftType, commonType, ConversionKind.IMPLICIT, expression.left);
          right = this.convertExpression(right, rightType, commonType, ConversionKind.IMPLICIT, expression.right);
        } else {
          this.error(
            DiagnosticCode.Operator_0_cannot_be_applied_to_types_1_and_2,
            expression.range, "<=", leftType.toString(), rightType.toString()
          );
          this.currentType = contextualType;
          return this.module.createUnreachable();
        }
        switch (commonType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.I32: {
            expr = this.module.createBinary(BinaryOp.LeI32, left, right);
            break;
          }
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.LeI64
                : BinaryOp.LeI32,
              left,
              right
            );
            break;
          }
          case TypeKind.I64: {
            expr = this.module.createBinary(BinaryOp.LeI64, left, right);
            break;
          }
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.U32:
          case TypeKind.BOOL: {
            expr = this.module.createBinary(BinaryOp.LeU32, left, right);
            break;
          }
          case TypeKind.USIZE: { // TODO: check operator overload
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.LeU64
                : BinaryOp.LeU32,
              left,
              right
            );
            break;
          }
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.LeU64, left, right);
            break;
          }
          case TypeKind.F32: {
            expr = this.module.createBinary(BinaryOp.LeF32, left, right);
            break;
          }
          case TypeKind.F64: {
            expr = this.module.createBinary(BinaryOp.LeF64, left, right);
            break;
          }
          default: {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            throw new Error("concrete type expected");
          }
        }
        this.currentType = Type.bool;
        break;
      }
      case Token.GREATERTHAN_EQUALS: {
        left = this.compileExpressionRetainType(expression.left, contextualType);
        leftType = this.currentType;
        right = this.compileExpressionRetainType(expression.right, leftType);
        rightType = this.currentType;
        if (commonType = Type.commonCompatible(leftType, rightType, true)) {
          left = this.convertExpression(left, leftType, commonType, ConversionKind.IMPLICIT, expression.left);
          right = this.convertExpression(right, rightType, commonType, ConversionKind.IMPLICIT, expression.right);
        } else {
          this.error(
            DiagnosticCode.Operator_0_cannot_be_applied_to_types_1_and_2,
            expression.range, ">=", leftType.toString(), rightType.toString()
          );
          this.currentType = contextualType;
          return this.module.createUnreachable();
        }
        switch (commonType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.I32: {
            expr = this.module.createBinary(BinaryOp.GeI32, left, right);
            break;
          }
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.GeI64
                : BinaryOp.GeI32,
              left,
              right
            );
            break;
          }
          case TypeKind.I64: {
            expr = this.module.createBinary(BinaryOp.GeI64, left, right);
            break;
          }
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.U32:
          case TypeKind.BOOL: {
            expr = this.module.createBinary(BinaryOp.GeU32, left, right);
            break;
          }
          case TypeKind.USIZE: { // TODO: check operator overload
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.GeU64
                : BinaryOp.GeU32,
              left,
              right
            );
            break;
          }
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.GeU64, left, right);
            break;
          }
          case TypeKind.F32: {
            expr = this.module.createBinary(BinaryOp.GeF32, left, right);
            break;
          }
          case TypeKind.F64: {
            expr = this.module.createBinary(BinaryOp.GeF64, left, right);
            break;
          }
          default: {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            throw new Error("concrete type expected");
          }
        }
        this.currentType = Type.bool;
        break;
      }

      case Token.EQUALS_EQUALS_EQUALS:
        // TODO?
      case Token.EQUALS_EQUALS: {

        // NOTE that this favors correctness, in terms of emitting a binary expression, over
        // checking for a possible use of unary EQZ. while the most classic of all optimizations,
        // that's not what the source told us to do. for reference, `!left` emits unary EQZ.

        left = this.compileExpressionRetainType(expression.left, contextualType);
        leftType = this.currentType;
        right = this.compileExpressionRetainType(expression.right, leftType);
        rightType = this.currentType;
        if (commonType = Type.commonCompatible(leftType, rightType, false)) {
          left = this.convertExpression(left, leftType, commonType, ConversionKind.IMPLICIT, expression.left);
          right = this.convertExpression(right, rightType, commonType, ConversionKind.IMPLICIT, expression.right);
        } else {
          this.error(
            DiagnosticCode.Operator_0_cannot_be_applied_to_types_1_and_2,
            expression.range, Token.operatorToString(expression.operator), leftType.toString(), rightType.toString()
          );
          this.currentType = contextualType;
          return this.module.createUnreachable();
        }
        switch (commonType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.I32:
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.U32:
          case TypeKind.BOOL: {
            expr = this.module.createBinary(BinaryOp.EqI32, left, right);
            break;
          }
          case TypeKind.USIZE: // TODO: check operator overload
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.EqI64
                : BinaryOp.EqI32,
              left,
              right
            );
            break;
          }
          case TypeKind.I64:
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.EqI64, left, right);
            break;
          }
          case TypeKind.F32: {
            expr = this.module.createBinary(BinaryOp.EqF32, left, right);
            break;
          }
          case TypeKind.F64: {
            expr = this.module.createBinary(BinaryOp.EqF64, left, right);
            break;
          }
          default: {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            throw new Error("concrete type expected");
          }
        }
        this.currentType = Type.bool;
        break;
      }
      case Token.EXCLAMATION_EQUALS_EQUALS:
        // TODO?
      case Token.EXCLAMATION_EQUALS: {
        left = this.compileExpressionRetainType(expression.left, contextualType);
        leftType = this.currentType;
        right = this.compileExpressionRetainType(expression.right, leftType);
        rightType = this.currentType;
        if (commonType = Type.commonCompatible(leftType, rightType, false)) {
          left = this.convertExpression(left, leftType, commonType, ConversionKind.IMPLICIT, expression.left);
          right = this.convertExpression(right, rightType, commonType, ConversionKind.IMPLICIT, expression.right);
        } else {
          this.error(
            DiagnosticCode.Operator_0_cannot_be_applied_to_types_1_and_2,
            expression.range, Token.operatorToString(expression.operator), leftType.toString(), rightType.toString()
          );
          this.currentType = contextualType;
          return this.module.createUnreachable();
        }
        switch (commonType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.I32:
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.U32:
          case TypeKind.BOOL: {
            expr = this.module.createBinary(BinaryOp.NeI32, left, right);
            break;
          }
          case TypeKind.USIZE: // TODO: check operator overload
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.NeI64
                : BinaryOp.NeI32,
              left,
              right
            );
            break;
          }
          case TypeKind.I64:
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.NeI64, left, right);
            break;
          }
          case TypeKind.F32: {
            expr = this.module.createBinary(BinaryOp.NeF32, left, right);
            break;
          }
          case TypeKind.F64: {
            expr = this.module.createBinary(BinaryOp.NeF64, left, right);
            break;
          }
          default: {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            throw new Error("concrete type expected");
          }
        }
        this.currentType = Type.bool;
        break;
      }
      case Token.EQUALS: {
        return this.compileAssignment(expression.left, expression.right, contextualType);
      }
      case Token.PLUS_EQUALS: compound = true;
      case Token.PLUS: {
        left = this.compileExpressionRetainType(
          expression.left,
          contextualType,
          false // retains low bits of small integers
        );
        if (compound) {
          right = this.compileExpression(
            expression.right,
            this.currentType,
            ConversionKind.IMPLICIT,
            false // ^
          );
        } else {
          leftType = this.currentType;
          right = this.compileExpressionRetainType(
            expression.right,
            leftType,
            false // ^
          );
          rightType = this.currentType;
          if (commonType = Type.commonCompatible(leftType, rightType, false)) {
            left = this.convertExpression(left, leftType, commonType, ConversionKind.IMPLICIT, expression.left);
            right = this.convertExpression(right, rightType, commonType, ConversionKind.IMPLICIT, expression.right);
          } else {
            this.error(
              DiagnosticCode.Operator_0_cannot_be_applied_to_types_1_and_2,
              expression.range, "+", leftType.toString(), rightType.toString()
            );
            this.currentType = contextualType;
            return this.module.createUnreachable();
          }
        }
        switch (this.currentType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.BOOL: possiblyOverflows = true;
          case TypeKind.I32:
          case TypeKind.U32: {
            expr = this.module.createBinary(BinaryOp.AddI32, left, right);
            break;
          }
          case TypeKind.USIZE: // TODO: check operator overload
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.AddI64
                : BinaryOp.AddI32,
              left,
              right
            );
            break;
          }
          case TypeKind.I64:
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.AddI64, left, right);
            break;
          }
          case TypeKind.F32: {
            expr = this.module.createBinary(BinaryOp.AddF32, left, right);
            break;
          }
          case TypeKind.F64: {
            expr = this.module.createBinary(BinaryOp.AddF64, left, right);
            break;
          }
          default: {
            throw new Error("concrete type expected");
          }
        }
        break;
      }
      case Token.MINUS_EQUALS: compound = true;
      case Token.MINUS: {
        left = this.compileExpressionRetainType(
          expression.left,
          contextualType,
          false // retains low bits of small integers
        );
        if (compound) {
          right = this.compileExpression(
            expression.right,
            this.currentType,
            ConversionKind.IMPLICIT,
            false // ^
          );
        } else {
          leftType = this.currentType;
          right = this.compileExpressionRetainType(
            expression.right,
            leftType,
            false // ^
          );
          rightType = this.currentType;
          if (commonType = Type.commonCompatible(leftType, rightType, false)) {
            left = this.convertExpression(left, leftType, commonType, ConversionKind.IMPLICIT, expression.left);
            right = this.convertExpression(right, rightType, commonType, ConversionKind.IMPLICIT, expression.right);
          } else {
            this.error(
              DiagnosticCode.Operator_0_cannot_be_applied_to_types_1_and_2,
              expression.range, "-", leftType.toString(), rightType.toString()
            );
            this.currentType = contextualType;
            return this.module.createUnreachable();
          }
        }
        switch (this.currentType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.BOOL: possiblyOverflows = true;
          case TypeKind.I32:
          case TypeKind.U32: {
            expr = this.module.createBinary(BinaryOp.SubI32, left, right);
            break;
          }
          case TypeKind.USIZE: // TODO: check operator overload
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.SubI64
                : BinaryOp.SubI32,
              left,
              right
            );
            break;
          }
          case TypeKind.I64:
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.SubI64, left, right);
            break;
          }
          case TypeKind.F32: {
            expr = this.module.createBinary(BinaryOp.SubF32, left, right);
            break;
          }
          case TypeKind.F64: {
            expr = this.module.createBinary(BinaryOp.SubF64, left, right);
            break;
          }
          default: {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            throw new Error("concrete type expected");
          }
        }
        break;
      }
      case Token.ASTERISK_EQUALS: compound = true;
      case Token.ASTERISK: {
        left = this.compileExpressionRetainType(
          expression.left,
          contextualType,
          false // retains low bits of small integers
        );
        if (compound) {
          right = this.compileExpression(
            expression.right,
            this.currentType,
            ConversionKind.IMPLICIT,
            false // ^
          );
        } else {
          leftType = this.currentType;
          right = this.compileExpressionRetainType(
            expression.right,
            leftType,
            false // ^
          );
          rightType = this.currentType;
          if (commonType = Type.commonCompatible(leftType, rightType, false)) {
            left = this.convertExpression(left, leftType, commonType, ConversionKind.IMPLICIT, expression.left);
            right = this.convertExpression(right, rightType, commonType, ConversionKind.IMPLICIT, expression.right);
          } else {
            this.error(
              DiagnosticCode.Operator_0_cannot_be_applied_to_types_1_and_2,
              expression.range, "*", leftType.toString(), rightType.toString()
            );
            this.currentType = contextualType;
            return this.module.createUnreachable();
          }
        }
        switch (this.currentType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.BOOL: possiblyOverflows = true;
          case TypeKind.I32:
          case TypeKind.U32: {
            expr = this.module.createBinary(BinaryOp.MulI32, left, right);
            break;
          }
          case TypeKind.USIZE: // TODO: check operator overload
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.MulI64
                : BinaryOp.MulI32,
              left,
              right
            );
            break;
          }
          case TypeKind.I64:
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.MulI64, left, right);
            break;
          }
          case TypeKind.F32: {
            expr = this.module.createBinary(BinaryOp.MulF32, left, right);
            break;
          }
          case TypeKind.F64: {
            expr = this.module.createBinary(BinaryOp.MulF64, left, right);
            break;
          }
          default: {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            throw new Error("concrete type expected");
          }
        }
        break;
      }
      case Token.SLASH_EQUALS: compound = true;
      case Token.SLASH: {
        left = this.compileExpressionRetainType(
          expression.left,
          contextualType,
          true // TODO: when can division remain unwrapped? does it overflow?
        );
        if (compound) {
          right = this.compileExpression(
            expression.right,
            this.currentType,
            ConversionKind.IMPLICIT,
            false // ^
          );
        } else {
          leftType = this.currentType;
          right = this.compileExpressionRetainType(
            expression.right,
            leftType,
            false // ^
          );
          rightType = this.currentType;
          if (commonType = Type.commonCompatible(leftType, rightType, false)) {
            left = this.convertExpression(left, leftType, commonType, ConversionKind.IMPLICIT, expression.left);
            right = this.convertExpression(right, rightType, commonType, ConversionKind.IMPLICIT, expression.right);
          } else {
            this.error(
              DiagnosticCode.Operator_0_cannot_be_applied_to_types_1_and_2,
              expression.range, "/", leftType.toString(), rightType.toString()
            );
            this.currentType = contextualType;
            return this.module.createUnreachable();
          }
        }
        switch (this.currentType.kind) {
          case TypeKind.I8:
          case TypeKind.I16: possiblyOverflows = true;
          case TypeKind.I32: {
            expr = this.module.createBinary(BinaryOp.DivI32, left, right);
            break;
          }
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.DivI64
                : BinaryOp.DivI32,
              left,
              right
            );
            break;
          }
          case TypeKind.I64: {
            expr = this.module.createBinary(BinaryOp.DivI64, left, right);
            break;
          }
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.BOOL: possiblyOverflows = true;
          case TypeKind.U32: {
            expr = this.module.createBinary(BinaryOp.DivU32, left, right);
            break;
          }
          case TypeKind.USIZE: { // TODO: check operator overload
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.DivU64
                : BinaryOp.DivU32,
              left,
              right
            );
            break;
          }
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.DivU64, left, right);
            break;
          }
          case TypeKind.F32: {
            expr = this.module.createBinary(BinaryOp.DivF32, left, right);
            break;
          }
          case TypeKind.F64: {
            expr = this.module.createBinary(BinaryOp.DivF64, left, right);
            break;
          }
          default: {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            throw new Error("concrete type expected");
          }
        }
        break;
      }
      case Token.PERCENT_EQUALS: compound = true;
      case Token.PERCENT: {
        left = this.compileExpressionRetainType(
          expression.left,
          contextualType,
          true // TODO: when can remainder remain unwrapped? does it overflow?
        );
        if (compound) {
          right = this.compileExpression(
            expression.right,
            this.currentType,
            ConversionKind.IMPLICIT,
            false // ^
          );
        } else {
          leftType = this.currentType;
          right = this.compileExpressionRetainType(
            expression.right,
            leftType,
            false // ^
          );
          rightType = this.currentType;
          if (commonType = Type.commonCompatible(leftType, rightType, false)) {
            left = this.convertExpression(left, leftType, commonType, ConversionKind.IMPLICIT, expression.left);
            right = this.convertExpression(right, rightType, commonType, ConversionKind.IMPLICIT, expression.right);
          } else {
            this.error(
              DiagnosticCode.Operator_0_cannot_be_applied_to_types_1_and_2,
              expression.range, "%", leftType.toString(), rightType.toString()
            );
            this.currentType = contextualType;
            return this.module.createUnreachable();
          }
        }
        switch (this.currentType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.I32: {
            expr = this.module.createBinary(BinaryOp.RemI32, left, right);
            break;
          }
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.RemI64
                : BinaryOp.RemI32,
              left,
              right
            );
            break;
          }
          case TypeKind.I64: {
            expr = this.module.createBinary(BinaryOp.RemI64, left, right);
            break;
          }
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.U32:
          case TypeKind.BOOL: {
            expr = this.module.createBinary(BinaryOp.RemU32, left, right);
            break;
          }
          case TypeKind.USIZE: { // TODO: check operator overload
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.RemU64
                : BinaryOp.RemU32,
              left,
              right
            );
            break;
          }
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.RemU64, left, right);
            break;
          }
          case TypeKind.F32:
          case TypeKind.F64: {
            // TODO: internal fmod, possibly simply imported from JS
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            expr = this.module.createUnreachable();
            break;
          }
          default: {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            throw new Error("concrete type expected");
          }
        }
        break;
      }
      case Token.LESSTHAN_LESSTHAN_EQUALS: compound = true;
      case Token.LESSTHAN_LESSTHAN: {
        left = this.compileExpressionRetainType(
          expression.left,
          contextualType,
          false // retains low bits of small integers
        );
        right = this.compileExpression(
          expression.right,
          this.currentType,
          ConversionKind.IMPLICIT,
          false // ^
        );
        switch (this.currentType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.BOOL: possiblyOverflows = true;
          default: {
            expr = this.module.createBinary(BinaryOp.ShlI32, left, right);
            break;
          }
          case TypeKind.I64:
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.ShlI64, left, right);
            break;
          }
          case TypeKind.USIZE: // TODO: check operator overload
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.ShlI64
                : BinaryOp.ShlI32,
              left,
              right
            );
            break;
          }
          case TypeKind.F32:
          case TypeKind.F64: {
            this.error(
              DiagnosticCode.The_0_operator_cannot_be_applied_to_type_1,
              expression.range, Token.operatorToString(expression.operator), this.currentType.toString()
            );
            return this.module.createUnreachable();
          }
          case TypeKind.VOID: {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            throw new Error("concrete type expected");
          }
        }
        break;
      }
      case Token.GREATERTHAN_GREATERTHAN_EQUALS: compound = true;
      case Token.GREATERTHAN_GREATERTHAN: {
        left = this.compileExpressionRetainType(
          expression.left,
          contextualType,
          true // must wrap small integers
        );
        right = this.compileExpression(
          expression.right,
          this.currentType,
          ConversionKind.IMPLICIT,
          true // ^
        );
        switch (this.currentType.kind) {
          default: {
            // assumes signed shr on signed small integers does not overflow
            expr = this.module.createBinary(BinaryOp.ShrI32, left, right);
            break;
          }
          case TypeKind.I64: {
            expr = this.module.createBinary(BinaryOp.ShrI64, left, right);
            break;
          }
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.ShrI64
                : BinaryOp.ShrI32,
              left,
              right
            );
            break;
          }
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.BOOL: // assumes unsigned shr on unsigned small integers does not overflow
          case TypeKind.U32: {
            expr = this.module.createBinary(BinaryOp.ShrU32, left, right);
            break;
          }
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.ShrU64, left, right);
            break;
          }
          case TypeKind.USIZE: { // TODO: check operator overload
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.ShrU64
                : BinaryOp.ShrU32,
              left,
              right
            );
            break;
          }
          case TypeKind.F32:
          case TypeKind.F64: {
            this.error(
              DiagnosticCode.The_0_operator_cannot_be_applied_to_type_1,
              expression.range, Token.operatorToString(expression.operator), this.currentType.toString()
            );
            return this.module.createUnreachable();
          }
          case TypeKind.VOID: {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            throw new Error("concrete type expected");
          }
        }
        break;
      }
      case Token.GREATERTHAN_GREATERTHAN_GREATERTHAN_EQUALS: compound = true;
      case Token.GREATERTHAN_GREATERTHAN_GREATERTHAN: {
        left = this.compileExpressionRetainType(
          expression.left,
          contextualType,
          true // modifies low bits of small integers if unsigned
        );
        right = this.compileExpression(
          expression.right,
          this.currentType,
          ConversionKind.IMPLICIT,
          true // ^
        );
        switch (this.currentType.kind) {
          case TypeKind.I8:
          case TypeKind.I16: possiblyOverflows = true;
          default: {
            // assumes that unsigned shr on unsigned small integers does not overflow
            expr = this.module.createBinary(BinaryOp.ShrU32, left, right);
            break;
          }
          case TypeKind.I64:
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.ShrU64, left, right);
            break;
          }
          case TypeKind.USIZE: // TODO: check operator overload
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.ShrU64
                : BinaryOp.ShrU32,
              left,
              right
            );
            break;
          }
          case TypeKind.VOID: {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            throw new Error("concrete type expected");
          }
        }
        break;
      }
      case Token.AMPERSAND_EQUALS: compound = true;
      case Token.AMPERSAND: {
        left = this.compileExpressionRetainType(
          expression.left,
          contextualType,
          false // retains low bits of small integers
        );
        if (compound) {
          right = this.compileExpression(
            expression.right,
            this.currentType,
            ConversionKind.IMPLICIT,
            false // ^
          );
        } else {
          leftType = this.currentType;
          right = this.compileExpressionRetainType(
            expression.right,
            leftType,
            false // ^
          );
          rightType = this.currentType;
          if (commonType = Type.commonCompatible(leftType, rightType, false)) {
            left = this.convertExpression(left, leftType, commonType, ConversionKind.IMPLICIT, expression.left);
            right = this.convertExpression(right, rightType, commonType, ConversionKind.IMPLICIT, expression.right);
          } else {
            this.error(
              DiagnosticCode.Operator_0_cannot_be_applied_to_types_1_and_2,
              expression.range, "&", leftType.toString(), rightType.toString()
            );
            this.currentType = contextualType;
            return this.module.createUnreachable();
          }
        }
        switch (this.currentType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.BOOL: possiblyOverflows = true; // if left or right already did
          default: {
            expr = this.module.createBinary(BinaryOp.AndI32, left, right);
            break;
          }
          case TypeKind.I64:
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.AndI64, left, right);
            break;
          }
          case TypeKind.USIZE: // TODO: check operator overload
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.AndI64
                : BinaryOp.AndI32,
              left,
              right
            );
            break;
          }
          case TypeKind.VOID: {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            throw new Error("concrete type expected");
          }
        }
        break;
      }
      case Token.BAR_EQUALS: compound = true;
      case Token.BAR: {
        left = this.compileExpressionRetainType(
          expression.left,
          contextualType,
          false // retains low bits of small integers
        );
        if (compound) {
          right = this.compileExpression(
            expression.right,
            this.currentType,
            ConversionKind.IMPLICIT,
            false // ^
          );
        } else {
          leftType = this.currentType;
          right = this.compileExpressionRetainType(
            expression.right,
            leftType,
            false // ^
          );
          rightType = this.currentType;
          if (commonType = Type.commonCompatible(leftType, rightType, false)) {
            left = this.convertExpression(left, leftType, commonType, ConversionKind.IMPLICIT, expression.left);
            right = this.convertExpression(right, rightType, commonType, ConversionKind.IMPLICIT, expression.right);
          } else {
            this.error(
              DiagnosticCode.Operator_0_cannot_be_applied_to_types_1_and_2,
              expression.range, "|", leftType.toString(), rightType.toString()
            );
            this.currentType = contextualType;
            return this.module.createUnreachable();
          }
        }
        switch (this.currentType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.BOOL: possiblyOverflows = true; // if left or right already did
          default: {
            expr = this.module.createBinary(BinaryOp.OrI32, left, right);
            break;
          }
          case TypeKind.I64:
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.OrI64, left, right);
            break;
          }
          case TypeKind.USIZE: // TODO: check operator overload
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.OrI64
                : BinaryOp.OrI32,
              left,
              right
            );
            break;
          }
          case TypeKind.VOID: {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            throw new Error("concrete type expected");
          }
        }
        break;
      }
      case Token.CARET_EQUALS: compound = true;
      case Token.CARET: {
        left = this.compileExpressionRetainType(
          expression.left,
          contextualType,
          false // retains low bits of small integers
        );
        if (compound) {
          right = this.compileExpression(
            expression.right,
            this.currentType,
            ConversionKind.IMPLICIT,
            false // ^
          );
        } else {
          leftType = this.currentType;
          right = this.compileExpressionRetainType(
            expression.right,
            leftType,
            false // ^
          );
          rightType = this.currentType;
          if (commonType = Type.commonCompatible(leftType, rightType, false)) {
            left = this.convertExpression(left, leftType, commonType, ConversionKind.IMPLICIT, expression.left);
            right = this.convertExpression(right, rightType, commonType, ConversionKind.IMPLICIT, expression.right);
          } else {
            this.error(
              DiagnosticCode.Operator_0_cannot_be_applied_to_types_1_and_2,
              expression.range, "^", leftType.toString(), rightType.toString()
            );
            this.currentType = contextualType;
            return this.module.createUnreachable();
          }
        }
        switch (this.currentType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.BOOL: possiblyOverflows = true; // if left or right already did
          default: {
            expr = this.module.createBinary(BinaryOp.XorI32, left, right);
            break;
          }
          case TypeKind.I64:
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.XorI64, left, right);
            break;
          }
          case TypeKind.USIZE: // TODO: check operator overload
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.XorI64
                : BinaryOp.XorI32,
              left,
              right
            );
            break;
          }
          case TypeKind.VOID: {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            throw new Error("concrete type expected");
          }
        }
        break;
      }

      // logical (no overloading)

      case Token.AMPERSAND_AMPERSAND: { // left && right
        left = this.compileExpressionRetainType(
          expression.left,
          contextualType
        );
        right = this.compileExpression(
          expression.right,
          this.currentType,
          ConversionKind.IMPLICIT,
          false
        );

        // clone left if free of side effects
        expr = this.module.cloneExpression(left, true, 0);

        // if not possible, tee left to a temp. local
        if (!expr) {
          tempLocal = this.currentFunction.getAndFreeTempLocal(this.currentType);
          left = this.module.createTeeLocal(tempLocal.index, left);
        }

        possiblyOverflows = this.currentType.is(TypeFlags.SMALL | TypeFlags.INTEGER);
        condition = makeIsTrueish(left, this.currentType, this.module);

        // simplify when cloning left without side effects was successful
        if (expr) {
          expr = this.module.createIf(
            condition, // left
            right,     //   ? right
            expr       //   : cloned left
          );
        }

        // otherwise make use of the temp. local
        else {
          expr = this.module.createIf(
            condition,
            right,
            this.module.createGetLocal(
              assert(tempLocal, "tempLocal must be set").index,
              this.currentType.toNativeType()
            )
          );
        }
        break;
      }
      case Token.BAR_BAR: { // left || right
        left = this.compileExpressionRetainType(
          expression.left,
          contextualType
        );
        right = this.compileExpression(
          expression.right,
          this.currentType,
          ConversionKind.IMPLICIT,
          false
        );

        // clone left if free of side effects
        expr = this.module.cloneExpression(left, true, 0);

        // if not possible, tee left to a temp. local
        if (!expr) {
          tempLocal = this.currentFunction.getAndFreeTempLocal(this.currentType);
          left = this.module.createTeeLocal(tempLocal.index, left);
        }

        possiblyOverflows = this.currentType.is(TypeFlags.SMALL | TypeFlags.INTEGER); // if right did
        condition = makeIsTrueish(left, this.currentType, this.module);

        // simplify when cloning left without side effects was successful
        if (expr) {
          expr = this.module.createIf(
            condition, // left
            expr,      //   ? cloned left
            right      //   : right
          );
        }

        // otherwise make use of the temp. local
        else {
          expr = this.module.createIf(
            condition,
            this.module.createGetLocal(
              assert(tempLocal, "tempLocal must be set").index,
              this.currentType.toNativeType()
            ),
            right
          );
        }
        break;
      }
      default: {
        this.error(
          DiagnosticCode.Operation_not_supported,
          expression.range
        );
        throw new Error("not implemented");
      }
    }
    if (possiblyOverflows && wrapSmallIntegers) {
      assert(this.currentType.is(TypeFlags.SMALL | TypeFlags.INTEGER), "small integer type expected");
      expr = makeSmallIntegerWrap(expr, this.currentType, this.module);
    }
    return compound
      ? this.compileAssignmentWithValue(expression.left, expr, contextualType != Type.void)
      : expr;
  }

  compileAssignment(expression: Expression, valueExpression: Expression, contextualType: Type): ExpressionRef {
    var resolved = this.program.resolveExpression(expression, this.currentFunction); // reports
    if (!resolved) return this.module.createUnreachable();

    // to compile just the value, we need to know the target's type
    var element = resolved.element;
    var elementType: Type;
    switch (element.kind) {
      case ElementKind.GLOBAL: {
        if (!this.compileGlobal(<Global>element)) { // reports; not yet compiled if a static field compiled as a global
          return this.module.createUnreachable();
        }
        assert((<Global>element).type != Type.void, "concrete type expected");
        // fall-through
      }
      case ElementKind.LOCAL:
      case ElementKind.FIELD: {
        elementType = (<VariableLikeElement>element).type;
        break;
      }
      case ElementKind.PROPERTY: {
        let prototype = (<Property>element).setterPrototype;
        if (prototype) {
          let instance = prototype.resolve(); // reports
          if (!instance) return this.module.createUnreachable();
          let signature = instance.signature;
          assert(signature.parameterTypes.length == 1);
          elementType = signature.parameterTypes[0];
          break;
        }
        this.error(
          DiagnosticCode.Cannot_assign_to_0_because_it_is_a_constant_or_a_read_only_property,
          expression.range, (<Property>element).internalName
        );
        return this.module.createUnreachable();
      }
      case ElementKind.FUNCTION_PROTOTYPE: {
        if (expression.kind == NodeKind.ELEMENTACCESS) { // @operator("[]")
          if (resolved.target && resolved.target.kind == ElementKind.CLASS) {
            if (element.simpleName == (<Class>resolved.target).prototype.fnIndexedGet) {
              let resolvedIndexedSet = (<FunctionPrototype>element).resolve(null); // reports
              if (resolvedIndexedSet) {
                elementType = resolvedIndexedSet.signature.returnType;
                break;
              }
            } else {
              this.error(
                DiagnosticCode.Index_signature_is_missing_in_type_0,
                expression.range, (<Class>resolved.target).toString()
              );
              return this.module.createUnreachable();
            }
          }
        }
        // fall-through
      }
      default: {
        this.error(
          DiagnosticCode.Operation_not_supported,
          expression.range
        );
        return this.module.createUnreachable();
      }
    }

    // compile the value and do the assignment
    var valueExpr = this.compileExpression(valueExpression, elementType);
    return this.compileAssignmentWithValue(
      expression,
      valueExpr,
      contextualType != Type.void
    );
  }

  compileAssignmentWithValue(
    expression: Expression,
    valueWithCorrectType: ExpressionRef,
    tee: bool = false
  ): ExpressionRef {
    var resolved = this.program.resolveExpression(expression, this.currentFunction); // reports
    if (!resolved) return this.module.createUnreachable();

    var element = resolved.element;
    switch (element.kind) {
      case ElementKind.LOCAL: {
        this.currentType = tee ? (<Local>element).type : Type.void;
        if ((<Local>element).is(ElementFlags.CONSTANT)) {
          this.error(
            DiagnosticCode.Cannot_assign_to_0_because_it_is_a_constant_or_a_read_only_property,
            expression.range, (<Local>element).internalName
          );
          return this.module.createUnreachable();
        }
        return tee
          ? this.module.createTeeLocal((<Local>element).index, valueWithCorrectType)
          : this.module.createSetLocal((<Local>element).index, valueWithCorrectType);
      }
      case ElementKind.GLOBAL: {
        if (!this.compileGlobal(<Global>element)) return this.module.createUnreachable();
        assert((<Global>element).type != Type.void, "concrete type expected");
        this.currentType = tee ? (<Global>element).type : Type.void;
        if ((<Local>element).is(ElementFlags.CONSTANT)) {
          this.error(
            DiagnosticCode.Cannot_assign_to_0_because_it_is_a_constant_or_a_read_only_property,
            expression.range,
            (<Local>element).internalName
          );
          return this.module.createUnreachable();
        }
        if (tee) {
          let nativeType = (<Global>element).type.toNativeType();
          return this.module.createBlock(null, [ // emulated teeGlobal
            this.module.createSetGlobal((<Global>element).internalName, valueWithCorrectType),
            this.module.createGetGlobal((<Global>element).internalName, nativeType)
          ], nativeType);
        } else {
          return this.module.createSetGlobal((<Global>element).internalName, valueWithCorrectType);
        }
      }
      case ElementKind.FIELD: {
        if ((<Field>element).prototype.isReadonly) {
          this.error(
            DiagnosticCode.Cannot_assign_to_0_because_it_is_a_constant_or_a_read_only_property,
            expression.range, (<Field>element).internalName
          );
          return this.module.createUnreachable();
        }
        assert(resolved.isInstanceTarget);
        let targetExpr = this.compileExpression(
          <Expression>resolved.targetExpression,
          (<Class>resolved.target).type
        );
        this.currentType = tee ? (<Field>element).type : Type.void;
        let nativeType = (<Field>element).type.toNativeType();
        if (tee) {
          let tempLocal = this.currentFunction.getAndFreeTempLocal((<Field>element).type);
          // TODO: simplify if valueWithCorrectType has no side effects
          return this.module.createBlock(null, [
            this.module.createSetLocal(tempLocal.index, valueWithCorrectType),
            this.module.createStore(
              (<Field>element).type.size >> 3,
              targetExpr,
              this.module.createGetLocal(tempLocal.index, nativeType),
              nativeType,
              (<Field>element).memoryOffset
            ),
            this.module.createGetLocal(tempLocal.index, nativeType)
          ], nativeType);
        } else {
          return this.module.createStore(
            (<Field>element).type.size >> 3,
            targetExpr,
            valueWithCorrectType,
            nativeType,
            (<Field>element).memoryOffset
          );
        }
      }
      case ElementKind.PROPERTY: {
        let setterPrototype = (<Property>element).setterPrototype;
        if (setterPrototype) {
          let setterInstance = setterPrototype.resolve(); // reports
          if (!setterInstance) return this.module.createUnreachable();

          // call just the setter if the return value isn't of interest
          if (!tee) {
            if (setterInstance.is(ElementFlags.INSTANCE)) {
              assert(resolved.isInstanceTarget);
              let thisArg = this.compileExpression(
                <Expression>resolved.targetExpression,
                (<Class>resolved.target).type
              );
              return this.makeCallDirect(setterInstance, [ thisArg, valueWithCorrectType ]);
            } else {
              return this.makeCallDirect(setterInstance, [ valueWithCorrectType ]);
            }
          }

          // otherwise call the setter first, then the getter
          let getterPrototype = (<Property>element).getterPrototype;
          assert(getterPrototype != null); // must have one if there is a setter
          let getterInstance = (<FunctionPrototype>getterPrototype).resolve(); // reports
          if (!getterInstance) return this.module.createUnreachable();
          let returnType = getterInstance.signature.returnType;
          if (setterInstance.is(ElementFlags.INSTANCE)) {
            assert(resolved.isInstanceTarget);
            let thisArg = this.compileExpression(
              <Expression>resolved.targetExpression,
              (<Class>resolved.target).type
            );
            let tempLocal = this.currentFunction.getAndFreeTempLocal(returnType);
            return this.module.createBlock(null, [
              this.makeCallDirect(setterInstance, [ // set and remember the target
                this.module.createTeeLocal(tempLocal.index, thisArg),
                valueWithCorrectType
              ]),
              this.makeCallDirect(getterInstance, [ // get from remembered target
                this.module.createGetLocal(tempLocal.index, returnType.toNativeType())
              ])
            ], returnType.toNativeType());
          } else {
            // note that this must be performed here because `resolved` is shared
            return this.module.createBlock(null, [
              this.makeCallDirect(setterInstance, [ valueWithCorrectType ]),
              this.makeCallDirect(getterInstance)
            ], returnType.toNativeType());
          }
        } else {
          this.error(
            DiagnosticCode.Cannot_assign_to_0_because_it_is_a_constant_or_a_read_only_property,
            expression.range, (<Property>element).internalName
          );
        }
        return this.module.createUnreachable();
      }
      case ElementKind.FUNCTION_PROTOTYPE: { // @operator("[]") ?
        if (expression.kind == NodeKind.ELEMENTACCESS) {
          assert(resolved.isInstanceTarget);
          let getterInstance = (<FunctionPrototype>element).resolve(); // reports
          if (!getterInstance) return this.module.createUnreachable();
          // obtain @operator("[]=")
          let setElementName = (<Class>resolved.target).prototype.fnIndexedSet;
          let setElement: Element | null;
          if (
            setElementName != null &&
            (<Class>resolved.target).members &&
            (setElement = (<Map<string,Element>>(<Class>resolved.target).members).get(setElementName)) &&
            setElement.kind == ElementKind.FUNCTION_PROTOTYPE
          ) {
            let setterInstance = (<FunctionPrototype>setElement).resolve(); // reports
            if (!setterInstance) return this.module.createUnreachable();
            let targetType = (<Class>resolved.target).type;
            let targetExpr = this.compileExpression(
              <Expression>resolved.targetExpression,
              targetType
            );
            let elementExpr = this.compileExpression(
              (<ElementAccessExpression>expression).elementExpression,
              Type.i32
            );
            if (tee) {
              let tempLocalTarget = this.currentFunction.getTempLocal(targetType);
              let tempLocalElement = this.currentFunction.getAndFreeTempLocal(this.currentType);
              let returnType = getterInstance.signature.returnType;
              this.currentFunction.freeTempLocal(tempLocalTarget);
              return this.module.createBlock(null, [
                this.makeCallDirect(setterInstance, [
                  this.module.createTeeLocal(tempLocalTarget.index, targetExpr),
                  this.module.createTeeLocal(tempLocalElement.index, elementExpr),
                  valueWithCorrectType
                ]),
                this.makeCallDirect(getterInstance, [
                  this.module.createGetLocal(tempLocalTarget.index, tempLocalTarget.type.toNativeType()),
                  this.module.createGetLocal(tempLocalElement.index, tempLocalElement.type.toNativeType())
                ])
              ], returnType.toNativeType());
            } else {
              return this.makeCallDirect(setterInstance, [
                targetExpr,
                elementExpr,
                valueWithCorrectType
              ]);
            }
          } else {
            this.error(
              DiagnosticCode.Index_signature_in_type_0_only_permits_reading,
              expression.range, (<Class>resolved.target).internalName
            );
            return this.module.createUnreachable();
          }
        }
        // fall-through
      }
    }
    this.error(
      DiagnosticCode.Operation_not_supported,
      expression.range
    );
    return this.module.createUnreachable();
  }

  compileCallExpression(expression: CallExpression, contextualType: Type): ExpressionRef {
    var resolved = this.program.resolveExpression(expression.expression, this.currentFunction); // reports
    if (!resolved) return this.module.createUnreachable();

    var element = resolved.element;
    var signature: Signature | null;
    var indexArg: ExpressionRef;
    switch (element.kind) {

      // direct call: concrete function
      case ElementKind.FUNCTION_PROTOTYPE: {
        let prototype = <FunctionPrototype>element;

        // builtins are compiled on the fly
        if (prototype.is(ElementFlags.BUILTIN)) {
          let expr = compileBuiltinCall( // reports
            this,
            prototype,
            prototype.resolveBuiltinTypeArguments(
              expression.typeArguments,
              this.currentFunction.contextualTypeArguments
            ),
            expression.arguments,
            contextualType,
            expression
          );
          if (!expr) {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            return this.module.createUnreachable();
          }
          return expr;

        // otherwise compile to a call
        } else {
          let instance = prototype.resolveUsingTypeArguments( // reports
            expression.typeArguments,
            this.currentFunction.contextualTypeArguments,
            expression
          );
          if (!instance) return this.module.createUnreachable();
          let thisArg: ExpressionRef = 0;
          if (instance.is(ElementFlags.INSTANCE)) {
            assert(resolved.isInstanceTarget);
            thisArg = this.compileExpression(
              <Expression>resolved.targetExpression,
              (<Class>resolved.target).type
            );
            if (!thisArg) return this.module.createUnreachable();
          } else {
            assert(!resolved.isInstanceTarget);
          }
          return this.compileCallDirect(instance, expression.arguments, expression, thisArg);
        }
      }

      // indirect call: index argument with signature
      case ElementKind.LOCAL: {
        if (signature = (<Local>element).type.functionType) {
          indexArg = this.module.createGetLocal((<Local>element).index, NativeType.I32);
          break;
        } else {
          this.error(
            DiagnosticCode.Cannot_invoke_an_expression_whose_type_lacks_a_call_signature_Type_0_has_no_compatible_call_signatures,
            expression.range, (<Local>element).type.toString()
          );
          return this.module.createUnreachable();
        }
      }
      case ElementKind.GLOBAL: {
        if (signature = (<Global>element).type.functionType) {
          indexArg = this.module.createGetGlobal((<Global>element).internalName, (<Global>element).type.toNativeType());
          break;
        } else {
          this.error(
            DiagnosticCode.Cannot_invoke_an_expression_whose_type_lacks_a_call_signature_Type_0_has_no_compatible_call_signatures,
            expression.range, (<Global>element).type.toString()
          );
          return this.module.createUnreachable();
        }
      }
      case ElementKind.FIELD: {
        let type = (<Field>element).type;
        if (signature = type.functionType) {
          let targetExpr = this.compileExpression(assert(resolved.targetExpression), type);
          indexArg = this.module.createLoad(
            4,
            false,
            targetExpr,
            NativeType.I32,
            (<Field>element).memoryOffset
          );
          break;
        } else {
          this.error(
            DiagnosticCode.Cannot_invoke_an_expression_whose_type_lacks_a_call_signature_Type_0_has_no_compatible_call_signatures,
            expression.range, (<Field>element).type.toString()
          );
          return this.module.createUnreachable();
        }
      }
      case ElementKind.FUNCTION_TARGET: {
        signature = (<FunctionTarget>element).signature;
        indexArg = this.compileExpression(expression.expression, (<FunctionTarget>element).type);
        break;
      }
      case ElementKind.PROPERTY: // TODO

      // not supported
      default: {
        this.error(
          DiagnosticCode.Operation_not_supported,
          expression.range
        );
        return this.module.createUnreachable();
      }
    }
    return this.compileCallIndirect(
      signature,
      indexArg,
      expression.arguments,
      expression
    );
  }

  /**
   * Checks that a call with the given number as arguments can be performed according to the
   * specified signature.
   */
  checkCallSignature(
    signature: Signature,
    numArguments: i32,
    hasThis: bool,
    reportNode: Node
  ): bool {

    // cannot call an instance method without a `this` argument (TODO: `.call`?)
    var thisType = signature.thisType;
    if (hasThis != (thisType != null)) {
      this.error(
        DiagnosticCode.Operation_not_supported, // TODO: better message?
        reportNode.range
      );
      return false;
    }

    // not yet implemented (TODO: maybe some sort of an unmanaged/lightweight array?)
    var hasRest = signature.hasRest;
    if (hasRest) {
      this.error(
        DiagnosticCode.Operation_not_supported,
        reportNode.range
      );
      return false;
    }

    var minimum = signature.requiredParameters;
    var maximum = signature.parameterTypes.length;

    // must at least be called with required arguments
    if (numArguments < minimum) {
      this.error(
        minimum < maximum
          ? DiagnosticCode.Expected_at_least_0_arguments_but_got_1
          : DiagnosticCode.Expected_0_arguments_but_got_1,
        reportNode.range, minimum.toString(), numArguments.toString()
      );
      return false;
    }

    // must not be called with more than the maximum arguments
    if (numArguments > maximum && !hasRest) {
      this.error(
        DiagnosticCode.Expected_0_arguments_but_got_1,
        reportNode.range, maximum.toString(), numArguments.toString()
      );
      return false;
    }

    return true;
  }

  /** Compiles a direct call to a concrete function. */
  compileCallDirect(
    instance: Function,
    argumentExpressions: Expression[],
    reportNode: Node,
    thisArg: ExpressionRef = 0
  ): ExpressionRef {
    var numArguments = argumentExpressions.length;
    var signature = instance.signature;

    if (!this.checkCallSignature( // reports
      signature,
      numArguments,
      thisArg != 0,
      reportNode
    )) {
      return this.module.createUnreachable();
    }

    var numArgumentsInclThis = thisArg ? numArguments + 1 : numArguments;
    var operands = new Array<ExpressionRef>(numArgumentsInclThis);
    var index = 0;
    if (thisArg) {
      operands[0] = thisArg;
      index = 1;
    }
    var parameterTypes = signature.parameterTypes;
    for (let i = 0; i < numArguments; ++i, ++index) {
      operands[index] = this.compileExpression(
        argumentExpressions[i],
        parameterTypes[i]
      );
    }
    assert(index == numArgumentsInclThis);
    return this.makeCallDirect(instance, operands);
  }

  /** Gets the trampoline for the specified function. */
  ensureTrampoline(original: Function): Function {
    var trampoline = original.trampoline;
    if (trampoline) return trampoline;

    var originalSignature = original.signature;
    var originalName = original.internalName;
    var originalParameterTypes = originalSignature.parameterTypes;
    var originalParameterDeclarations = original.prototype.declaration.signature.parameterTypes;
    var commonReturnType = originalSignature.returnType;
    var commonThisType = originalSignature.thisType;
    var isInstance = original.is(ElementFlags.INSTANCE);

    // arguments excl. `this`, operands incl. `this`
    var minArguments = originalSignature.requiredParameters;
    var minOperands = minArguments;
    var maxArguments = originalParameterTypes.length;
    var maxOperands = maxArguments;
    if (isInstance) {
      ++minOperands;
      ++maxOperands;
    }
    var numOptional = maxOperands - minOperands;
    assert(numOptional);

    var forwardedOperands = new Array<ExpressionRef>(minOperands);
    var operandIndex = 0;

    // forward `this` if applicable
    if (isInstance) {
      forwardedOperands[0] = this.module.createGetLocal(0, this.options.nativeSizeType);
      operandIndex = 1;
    }

    // forward required arguments
    for (let i = 0; i < minArguments; ++i, ++operandIndex) {
      let parameterType = originalParameterTypes[i];
      forwardedOperands[operandIndex] = this.module.createGetLocal(operandIndex, parameterType.toNativeType());
    }
    assert(operandIndex == minOperands);

    // append an additional parameter taking the number of optional arguments provided
    var trampolineParameterTypes = new Array<Type>(maxArguments + 1);
    for (let i = 0; i < maxArguments; ++i) {
      trampolineParameterTypes[i] = originalParameterTypes[i];
    }
    trampolineParameterTypes[maxArguments] = Type.i32;

    // create the trampoline element
    var trampolineSignature = new Signature(trampolineParameterTypes, commonReturnType, commonThisType);
    var trampolineName = originalName + "|trampoline";
    trampolineSignature.requiredParameters = maxArguments + 1;
    trampoline = new Function(original.prototype, trampolineName, trampolineSignature, original.instanceMethodOf);
    trampoline.flags = original.flags | ElementFlags.COMPILED;
    original.trampoline = trampoline;

    // compile initializers of omitted arguments in scope of the trampoline function
    // this is necessary because initializers might need additional locals and a proper this context
    var previousFunction = this.currentFunction;
    this.currentFunction = trampoline;

    // create a br_table switching over the number of optional parameters provided
    var numNames = numOptional + 1; // incl. 'with0'
    var names = new Array<string>(numNames);
    for (let i = 0; i < numNames; ++i) {
      let label = "N=" + i.toString();
      names[i] = label;
    }
    var body = this.module.createBlock(names[0], [
      this.module.createBlock("N=invalid", [
        this.module.createSwitch(names, "N=invalid",
          this.module.createGetLocal(maxOperands, NativeType.I32)
        )
      ]),
      this.module.createUnreachable()
    ]);
    for (let i = 0; i < numOptional; ++i, ++operandIndex) {
      let type = originalParameterTypes[minArguments + i];
      body = this.module.createBlock(names[i + 1], [
        body,
        this.module.createSetLocal(operandIndex,
          this.compileExpression(
            assert(originalParameterDeclarations[minArguments + i].initializer),
            type
          )
        )
      ]);
      forwardedOperands[operandIndex] = this.module.createGetLocal(operandIndex, type.toNativeType());
    }
    this.currentFunction = previousFunction;
    assert(operandIndex == maxOperands);

    var typeRef = this.ensureFunctionType(trampolineSignature);
    var funcRef = this.module.addFunction(trampolineName, typeRef, typesToNativeTypes(trampoline.additionalLocals),
      this.module.createBlock(null, [
        body,
        this.module.createCall(
          originalName,
          forwardedOperands,
          commonReturnType.toNativeType()
        )
      ], commonReturnType.toNativeType())
    );
    trampoline.finalize(this.module, funcRef);
    return trampoline;
  }

  /** Creates a direct call to the specified function. */
  makeCallDirect(instance: Function, operands: ExpressionRef[] | null = null): ExpressionRef {
    var numOperands = operands ? operands.length : 0;
    var numArguments = numOperands;
    var minArguments = instance.signature.requiredParameters;
    var minOperands = minArguments;
    var maxArguments = instance.signature.parameterTypes.length;
    var maxOperands = maxArguments;
    if (instance.is(ElementFlags.INSTANCE)) {
      ++minOperands;
      ++maxOperands;
      --numArguments;
    }
    assert(numOperands >= minOperands);
    if (!this.compileFunction(instance)) return this.module.createUnreachable();
    if (numOperands < maxOperands) {
      instance = this.ensureTrampoline(instance);
      if (!this.compileFunction(instance)) return this.module.createUnreachable();
      if (!operands) {
        operands = new Array(maxOperands + 1);
        operands.length = 0;
      }
      for (let i = numArguments; i < maxArguments; ++i) {
        operands.push(instance.signature.parameterTypes[i].toNativeZero(this.module));
      }
      operands.push(this.module.createI32(numOperands - minOperands));
    }
    var returnType = instance.signature.returnType;
    this.currentType = returnType;
    if (instance.is(ElementFlags.IMPORTED)) {
      return this.module.createCallImport(instance.internalName, operands, returnType.toNativeType());
    } else {
      return this.module.createCall(instance.internalName, operands, returnType.toNativeType());
    }
  }

  /** Compiles an indirect call using an index argument and a signature. */
  compileCallIndirect(
    signature: Signature,
    indexArg: ExpressionRef,
    argumentExpressions: Expression[],
    reportNode: Node,
    thisArg: ExpressionRef = 0
  ): ExpressionRef {
    var numArguments = argumentExpressions.length;

    if (!this.checkCallSignature( // reports
      signature,
      numArguments,
      thisArg != 0,
      reportNode
    )) {
      return this.module.createUnreachable();
    }

    var numArgumentsInclThis = thisArg ? numArguments + 1 : numArguments;
    var operands = new Array<ExpressionRef>(numArgumentsInclThis);
    var index = 0;
    if (thisArg) {
      operands[0] = thisArg;
      index = 1;
    }
    var parameterTypes = signature.parameterTypes;
    for (let i = 0; i < numArguments; ++i, ++index) {
      operands[index] = this.compileExpression(
        argumentExpressions[i],
        parameterTypes[i]
      );
    }
    assert(index == numArgumentsInclThis);
    return this.makeCallIndirect(signature, indexArg, operands);
  }

  /** Creates an indirect call to the function at `indexArg` in the function table. */
  makeCallIndirect(signature: Signature, indexArg: ExpressionRef, operands: ExpressionRef[]): ExpressionRef {
    var returnType = signature.returnType;
    this.currentType = returnType;
    this.ensureFunctionType(signature);
    return this.module.createCallIndirect(indexArg, operands, signature.toSignatureString());
  }

  compileCommaExpression(expression: CommaExpression, contextualType: Type): ExpressionRef {
    var expressions = expression.expressions;
    var numExpressions = expressions.length;
    var exprs = new Array<ExpressionRef>(numExpressions--);
    for (let i = 0; i < numExpressions; ++i) {
      exprs[i] = this.compileExpression(expressions[i], Type.void);    // drop all
    }
    exprs[numExpressions] = this.compileExpression(expressions[numExpressions], contextualType); // except last
    return this.module.createBlock(null, exprs, this.currentType.toNativeType());
  }

  compileElementAccessExpression(expression: ElementAccessExpression, contextualType: Type): ExpressionRef {
    var resolved = this.program.resolveElementAccess(expression, this.currentFunction); // reports
    if (!resolved) return this.module.createUnreachable();

    assert( // should be guaranteed by resolveElementAccess
      resolved.element.kind == ElementKind.FUNCTION_PROTOTYPE &&
      resolved.target &&
      resolved.target.kind == ElementKind.CLASS
    );
    var instance = (<FunctionPrototype>resolved.element).resolve( // reports
      null,
      (<Class>resolved.target).contextualTypeArguments
    );
    if (!instance) return this.module.createUnreachable();
    var thisArg = this.compileExpression(expression.expression, (<Class>resolved.target).type);
    return this.compileCallDirect(instance, [
      expression.elementExpression
    ], expression, thisArg);
  }

  compileFunctionExpression(expression: FunctionExpression, contextualType: Type): ExpressionRef {
    var declaration = expression.declaration;
    var simpleName = (declaration.name.text.length
      ? declaration.name.text
      : "anonymous") + "|" + this.functionTable.length.toString(10);
    var prototype = new FunctionPrototype(
      this.program,
      simpleName,
      this.currentFunction.internalName + "~" + simpleName,
      declaration
    );
    var instance = this.compileFunctionUsingTypeArguments(
      prototype,
      [],
      this.currentFunction.contextualTypeArguments,
      declaration
    );
    if (!instance) return this.module.createUnreachable();
    this.currentType = Type.u32.asFunction(instance.signature);
    // NOTE that, in order to make this work in every case, the function must be represented by a
    // value, so we add it and rely on the optimizer to figure out where it can be called directly.
    var index = this.ensureFunctionTableEntry(instance);
    if (index < 0) return this.module.createUnreachable();
    return this.module.createI32(index);
  }

  /**
   * Compiles an identifier in the specified context.
   * @param retainConstantType Retains the type of inlined constants if `true`, otherwise
   *  precomputes them according to context.
   */
  compileIdentifierExpression(
    expression: IdentifierExpression,
    contextualType: Type,
    retainConstantType: bool
  ): ExpressionRef {
    // check special keywords first
    switch (expression.kind) {
      case NodeKind.NULL: {
        if (!contextualType.classType) {
          this.currentType = this.options.usizeType;
        }
        return this.options.isWasm64
          ? this.module.createI64(0)
          : this.module.createI32(0);
      }
      case NodeKind.TRUE: {
        this.currentType = Type.bool;
        return this.module.createI32(1);
      }
      case NodeKind.FALSE: {
        this.currentType = Type.bool;
        return this.module.createI32(0);
      }
      case NodeKind.THIS: {
        if (this.currentFunction.is(ElementFlags.INSTANCE)) {
          let thisType = assert(this.currentFunction.instanceMethodOf).type;
          this.currentType = thisType;
          return this.module.createGetLocal(0, thisType.toNativeType());
        }
        this.error(
          DiagnosticCode._this_cannot_be_referenced_in_current_location,
          expression.range
        );
        this.currentType = this.options.usizeType;
        return this.module.createUnreachable();
      }
      case NodeKind.SUPER: {
        if (this.currentFunction.is(ElementFlags.INSTANCE)) {
          let base = assert(this.currentFunction.instanceMethodOf).base;
          if (base) {
            let superType = base.type;
            this.currentType = superType;
            return this.module.createGetLocal(0, superType.toNativeType());
          }
        }
        this.error(
          DiagnosticCode._super_can_only_be_referenced_in_a_derived_class,
          expression.range
        );
        this.currentType = this.options.usizeType;
        return this.module.createUnreachable();
      }
    }

    // otherwise resolve
    var resolved = this.program.resolveIdentifier( // reports
      expression,
      this.currentFunction,
      this.currentEnum
    );
    if (!resolved) return this.module.createUnreachable();

    var element = resolved.element;
    switch (element.kind) {
      case ElementKind.LOCAL: {
        if ((<Local>element).is(ElementFlags.INLINED)) {
          return this.compileInlineConstant(<Local>element, contextualType, retainConstantType);
        }
        assert((<Local>element).index >= 0);
        this.currentType = (<Local>element).type;
        return this.module.createGetLocal((<Local>element).index, this.currentType.toNativeType());
      }
      case ElementKind.GLOBAL: {
        if (element.is(ElementFlags.BUILTIN)) {
          return compileBuiltinGetConstant(this, <Global>element, expression);
        }
        if (!this.compileGlobal(<Global>element)) { // reports; not yet compiled if a static field
          return this.module.createUnreachable();
        }
        assert((<Global>element).type != Type.void);
        if ((<Global>element).is(ElementFlags.INLINED)) {
          return this.compileInlineConstant(<Global>element, contextualType, retainConstantType);
        }
        this.currentType = (<Global>element).type;
        return this.module.createGetGlobal((<Global>element).internalName, this.currentType.toNativeType());
      }
      case ElementKind.ENUMVALUE: { // here: if referenced from within the same enum
        if (!element.is(ElementFlags.COMPILED)) {
          this.error(
            DiagnosticCode.A_member_initializer_in_a_enum_declaration_cannot_reference_members_declared_after_it_including_members_defined_in_other_enums,
            expression.range
          );
          this.currentType = Type.i32;
          return this.module.createUnreachable();
        }
        this.currentType = Type.i32;
        if ((<EnumValue>element).is(ElementFlags.INLINED)) {
          return this.module.createI32((<EnumValue>element).constantValue);
        }
        return this.module.createGetGlobal((<EnumValue>element).internalName, NativeType.I32);
      }
    }
    this.error(
      DiagnosticCode.Operation_not_supported,
      expression.range
    );
    return this.module.createUnreachable();
  }

  compileLiteralExpression(
    expression: LiteralExpression,
    contextualType: Type,
    implicitNegate: bool = false
  ): ExpressionRef {
    switch (expression.literalKind) {
      case LiteralKind.ARRAY: {
        assert(!implicitNegate);
        let classType = contextualType.classType;
        if (
          classType &&
          classType == this.program.elements.get("Array") &&
          classType.typeArguments && classType.typeArguments.length == 1
        ) {
          return this.compileStaticArray(
            classType.typeArguments[0],
            (<ArrayLiteralExpression>expression).elementExpressions
          );
        }
        this.error(
          DiagnosticCode.Operation_not_supported,
          expression.range
        );
        return this.module.createUnreachable();
      }
      case LiteralKind.FLOAT: {
        let floatValue = (<FloatLiteralExpression>expression).value;
        if (implicitNegate) {
          floatValue = -floatValue;
        }
        if (contextualType == Type.f32) {
          return this.module.createF32(<f32>floatValue);
        }
        this.currentType = Type.f64;
        return this.module.createF64(floatValue);
      }
      case LiteralKind.INTEGER: {
        let intValue = (<IntegerLiteralExpression>expression).value;
        if (implicitNegate) {
          intValue = i64_sub(
            i64_new(0),
            intValue
          );
        }
        switch (contextualType.kind) {

          // compile to contextualType if matching

          case TypeKind.I8: {
            if (i64_is_i8(intValue)) return this.module.createI32(i64_low(intValue));
            break;
          }
          case TypeKind.I16: {
            if (i64_is_i16(intValue)) return this.module.createI32(i64_low(intValue));
            break;
          }
          case TypeKind.I32: {
            if (i64_is_i32(intValue)) return this.module.createI32(i64_low(intValue));
            break;
          }
          case TypeKind.U8: {
            if (i64_is_u8(intValue)) return this.module.createI32(i64_low(intValue));
            break;
          }
          case TypeKind.U16: {
            if (i64_is_u16(intValue)) return this.module.createI32(i64_low(intValue));
            break;
          }
          case TypeKind.U32: {
            if (i64_is_u32(intValue)) return this.module.createI32(i64_low(intValue));
            break;
          }
          case TypeKind.BOOL: {
            if (i64_is_bool(intValue)) return this.module.createI32(i64_low(intValue));
            break;
          }
          case TypeKind.ISIZE: {
            if (!this.options.isWasm64) {
              if (i64_is_u32(intValue)) return this.module.createI32(i64_low(intValue));
              break;
            }
            return this.module.createI64(i64_low(intValue), i64_high(intValue));
          }
          case TypeKind.USIZE: {
            if (!this.options.isWasm64) {
              if (i64_is_u32(intValue)) return this.module.createI32(i64_low(intValue));
              break;
            }
            return this.module.createI64(i64_low(intValue), i64_high(intValue));
          }
          case TypeKind.I64:
          case TypeKind.U64: {
            return this.module.createI64(i64_low(intValue), i64_high(intValue));
          }
          case TypeKind.F32: {
            if (i64_is_f32(intValue)) return this.module.createF32(i64_to_f32(intValue));
            break;
          }
          case TypeKind.F64: {
            if (i64_is_f64(intValue)) return this.module.createF64(i64_to_f64(intValue));
            break;
          }
          case TypeKind.VOID: {
            break; // compiles to best fitting type below, being dropped
          }
          default: {
            assert(false);
            break;
          }
        }

        // otherwise compile to best fitting native type

        if (i64_is_i32(intValue)) {
          this.currentType = Type.i32;
          return this.module.createI32(i64_low(intValue));
        } else {
          this.currentType = Type.i64;
          return this.module.createI64(i64_low(intValue), i64_high(intValue));
        }
      }
      case LiteralKind.STRING: {
        assert(!implicitNegate);
        return this.compileStaticString((<StringLiteralExpression>expression).value);
      }
      // case LiteralKind.OBJECT:
      // case LiteralKind.REGEXP:
    }
    this.error(
      DiagnosticCode.Operation_not_supported,
      expression.range
    );
    this.currentType = contextualType;
    return this.module.createUnreachable();
  }

  compileStaticString(stringValue: string): ExpressionRef {
    var stringSegment: MemorySegment | null = this.stringSegments.get(stringValue);
    if (!stringSegment) {
      let stringLength = stringValue.length;
      let stringBuffer = new Uint8Array(4 + stringLength * 2);
      stringBuffer[0] =  stringLength         & 0xff;
      stringBuffer[1] = (stringLength >>>  8) & 0xff;
      stringBuffer[2] = (stringLength >>> 16) & 0xff;
      stringBuffer[3] = (stringLength >>> 24) & 0xff;
      for (let i = 0; i < stringLength; ++i) {
        stringBuffer[4 + i * 2] =  stringValue.charCodeAt(i)        & 0xff;
        stringBuffer[5 + i * 2] = (stringValue.charCodeAt(i) >>> 8) & 0xff;
      }
      stringSegment = this.addMemorySegment(stringBuffer, this.options.usizeType.byteSize);
      this.stringSegments.set(stringValue, stringSegment);
    }
    var stringOffset = stringSegment.offset;
    var stringType = this.program.types.get("string");
    this.currentType = stringType ? stringType : this.options.usizeType;
    if (this.options.isWasm64) {
      return this.module.createI64(i64_low(stringOffset), i64_high(stringOffset));
    }
    assert(i64_is_i32(stringOffset));
    return this.module.createI32(i64_low(stringOffset));
  }

  compileStaticArray(elementType: Type, expressions: (Expression | null)[]): ExpressionRef {
    // compile as static if all element expressions are precomputable, otherwise
    // initialize in place.
    var isStatic = true;
    var size = expressions.length;

    var nativeType = elementType.toNativeType();
    var values: usize;
    switch (nativeType) {
      case NativeType.I32: {
        values = changetype<usize>(new Int32Array(size));
        break;
      }
      case NativeType.I64: {
        values = changetype<usize>(new Array<I64>(size));
        break;
      }
      case NativeType.F32: {
        values = changetype<usize>(new Float32Array(size));
        break;
      }
      case NativeType.F64: {
        values = changetype<usize>(new Float64Array(size));
        break;
      }
      default: {
        throw new Error("concrete type expected");
      }
    }

    var exprs = new Array<ExpressionRef>(size);
    var expr: BinaryenExpressionRef;
    for (let i = 0; i < size; ++i) {
      exprs[i] = expressions[i]
        ? this.compileExpression(<Expression>expressions[i], elementType)
        : elementType.toNativeZero(this.module);
      if (isStatic) {
        expr = this.precomputeExpressionRef(exprs[i]);
        if (_BinaryenExpressionGetId(expr) == ExpressionId.Const) {
          assert(_BinaryenExpressionGetType(expr) == nativeType);
          switch (nativeType) {
            case NativeType.I32: {
              changetype<i32[]>(values)[i] = _BinaryenConstGetValueI32(expr);
              break;
            }
            case NativeType.I64: {
              changetype<I64[]>(values)[i] = i64_new(
                _BinaryenConstGetValueI64Low(expr),
                _BinaryenConstGetValueI64High(expr)
              );
              break;
            }
            case NativeType.F32: {
              changetype<f32[]>(values)[i] = _BinaryenConstGetValueF32(expr);
              break;
            }
            case NativeType.F64: {
              changetype<f64[]>(values)[i] = _BinaryenConstGetValueF64(expr);
              break;
            }
            default: {
              assert(false); // checked above
            }
          }
        } else {
          // TODO: emit a warning if declared 'const'
          isStatic = false;
        }
      }
    }

    if (isStatic) {
      // TODO: convert to Uint8Array and create the segment
    } else {
      // TODO: initialize in place
    }
    // TODO: alternatively, static elements could go into data segments while
    // dynamic ones are initialized on top? any benefits? (doesn't seem so)
    throw new Error("not implemented");
  }

  compileNewExpression(expression: NewExpression, contextualType: Type): ExpressionRef {
    var resolved = this.program.resolveExpression( // reports
      expression.expression,
      this.currentFunction
    );
    if (resolved) {
      if (resolved.element.kind == ElementKind.CLASS_PROTOTYPE) {
        let prototype = <ClassPrototype>resolved.element;
        let instance = prototype.resolveUsingTypeArguments( // reports
          expression.typeArguments,
          null,
          expression
        );
        if (instance) {
          let thisExpr = compileBuiltinAllocate(this, instance, expression);
          let initializers = new Array<ExpressionRef>();

          // use a temp local for 'this'
          let tempLocal = this.currentFunction.getTempLocal(this.options.usizeType);
          initializers.push(this.module.createSetLocal(tempLocal.index, thisExpr));

          // apply field initializers
          if (instance.members) {
            for (let member of instance.members.values()) {
              if (member.kind == ElementKind.FIELD) {
                let field = <Field>member;
                let fieldDeclaration = field.prototype.declaration;
                if (field.is(ElementFlags.CONSTANT)) {
                  assert(false); // there are no built-in fields currently
                } else if (fieldDeclaration && fieldDeclaration.initializer) {
                  initializers.push(this.module.createStore(field.type.byteSize,
                    this.module.createGetLocal(tempLocal.index, this.options.nativeSizeType),
                    this.compileExpression(fieldDeclaration.initializer, field.type),
                    field.type.toNativeType(),
                    field.memoryOffset
                  ));
                }
              }
            }
          }

          // apply constructor
          let constructorInstance = instance.constructorInstance;
          if (constructorInstance) {
            initializers.push(this.compileCallDirect(constructorInstance, expression.arguments, expression,
              this.module.createGetLocal(tempLocal.index, this.options.nativeSizeType)
            ));
          }

          // return 'this'
          initializers.push(this.module.createGetLocal(tempLocal.index, this.options.nativeSizeType));
          this.currentFunction.freeTempLocal(tempLocal);
          thisExpr = this.module.createBlock(null, initializers, this.options.nativeSizeType);

          this.currentType = instance.type;
          return thisExpr;
        }
      } else {
        this.error(
          DiagnosticCode.Cannot_use_new_with_an_expression_whose_type_lacks_a_construct_signature,
          expression.expression.range
        );
      }
    }
    return this.module.createUnreachable();
  }

  compileParenthesizedExpression(
    expression: ParenthesizedExpression,
    contextualType: Type,
    wrapSmallIntegers: bool = true
  ): ExpressionRef {
    // does not change types, just order
    return this.compileExpression(
      expression.expression,
      contextualType,
      ConversionKind.NONE,
      wrapSmallIntegers
    );
  }

  /**
   * Compiles a property access in the specified context.
   * @param retainConstantType Retains the type of inlined constants if `true`, otherwise
   *  precomputes them according to context.
   */
  compilePropertyAccessExpression(
    propertyAccess: PropertyAccessExpression,
    contextualType: Type,
    retainConstantType: bool
  ): ExpressionRef {
    var resolved = this.program.resolvePropertyAccess(propertyAccess, this.currentFunction); // reports
    if (!resolved) return this.module.createUnreachable();

    var element = resolved.element;
    var targetExpr: ExpressionRef;
    switch (element.kind) {
      case ElementKind.GLOBAL: { // static property
        if (element.is(ElementFlags.BUILTIN)) {
          return compileBuiltinGetConstant(this, <Global>element, propertyAccess);
        }
        if (!this.compileGlobal(<Global>element)) { // reports; not yet compiled if a static field
          return this.module.createUnreachable();
        }
        assert((<Global>element).type != Type.void);
        if ((<Global>element).is(ElementFlags.INLINED)) {
          return this.compileInlineConstant(<Global>element, contextualType, retainConstantType);
        }
        this.currentType = (<Global>element).type;
        return this.module.createGetGlobal((<Global>element).internalName, this.currentType.toNativeType());
      }
      case ElementKind.ENUMVALUE: { // enum value
        if (!this.compileEnum((<EnumValue>element).enum)) {
          return this.module.createUnreachable();
        }
        this.currentType = Type.i32;
        if ((<EnumValue>element).is(ElementFlags.INLINED)) {
          return this.module.createI32((<EnumValue>element).constantValue);
        }
        return this.module.createGetGlobal((<EnumValue>element).internalName, NativeType.I32);
      }
      case ElementKind.FIELD: { // instance field
        assert(resolved.isInstanceTarget);
        assert((<Field>element).memoryOffset >= 0);
        targetExpr = this.compileExpression(
          <Expression>resolved.targetExpression,
          this.options.usizeType,
          ConversionKind.NONE
        );
        this.currentType = (<Field>element).type;
        return this.module.createLoad(
          (<Field>element).type.size >> 3,
          (<Field>element).type.is(TypeFlags.SIGNED | TypeFlags.INTEGER),
          targetExpr,
          (<Field>element).type.toNativeType(),
          (<Field>element).memoryOffset
        );
      }
      case ElementKind.PROPERTY: { // instance property (here: getter)
        let prototype = (<Property>element).getterPrototype;
        if (prototype) {
          let instance = prototype.resolve(null); // reports
          if (!instance) return this.module.createUnreachable();
          let signature = instance.signature;
          if (!this.checkCallSignature( // reports
            signature,
            0,
            instance.is(ElementFlags.INSTANCE),
            propertyAccess
          )) {
            return this.module.createUnreachable();
          }
          if (instance.instanceMethodOf) {
            targetExpr = this.compileExpression(
              <Expression>resolved.targetExpression,
              instance.instanceMethodOf.type
            );
            this.currentType = signature.returnType;
            return this.compileCallDirect(instance, [], propertyAccess, targetExpr);
          } else {
            this.currentType = signature.returnType;
            return this.compileCallDirect(instance, [], propertyAccess);
          }
        } else {
          this.error(
            DiagnosticCode.Property_0_does_not_exist_on_type_1,
            propertyAccess.range, (<Property>element).simpleName, (<Property>element).parent.toString()
          );
          return this.module.createUnreachable();
        }
      }
    }
    this.error(
      DiagnosticCode.Operation_not_supported,
      propertyAccess.range
    );
    return this.module.createUnreachable();
  }

  compileTernaryExpression(expression: TernaryExpression, contextualType: Type): ExpressionRef {
    var condition = makeIsTrueish(
      this.compileExpression(expression.condition, Type.u32, ConversionKind.NONE),
      this.currentType,
      this.module
    );
    var ifThen = this.compileExpression(expression.ifThen, contextualType);
    var ifElse = this.compileExpression(expression.ifElse, contextualType);
    return this.module.createIf(condition, ifThen, ifElse);
  }

  compileUnaryPostfixExpression(expression: UnaryPostfixExpression, contextualType: Type): ExpressionRef {
    // make a getter for the expression (also obtains the type)
    var getValue = this.compileExpression(
      expression.operand,
      contextualType == Type.void
        ? Type.i32
        : contextualType,
      ConversionKind.NONE,
      false // wrapped below
    );

    var op: BinaryOp;
    var nativeType: NativeType;
    var nativeOne: ExpressionRef;
    var possiblyOverflows = false;

    switch (expression.operator) {
      case Token.PLUS_PLUS: {
        if (this.currentType.isReference) {
          this.error(
            DiagnosticCode.Operation_not_supported,
            expression.range
          );
          return this.module.createUnreachable();
        }
        switch (this.currentType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.BOOL: possiblyOverflows = true;
          default: {
            op = BinaryOp.AddI32;
            nativeType = NativeType.I32;
            nativeOne = this.module.createI32(1);
            break;
          }
          case TypeKind.USIZE: // TODO: check operator overload
          case TypeKind.ISIZE: {
            op = this.options.isWasm64
              ? BinaryOp.AddI64
              : BinaryOp.AddI32;
            nativeType = this.options.isWasm64
              ? NativeType.I64
              : NativeType.I32;
            nativeOne = this.currentType.toNativeOne(this.module);
            break;
          }
          case TypeKind.I64:
          case TypeKind.U64: {
            op = BinaryOp.AddI64;
            nativeType = NativeType.I64;
            nativeOne = this.module.createI64(1);
            break;
          }
          case TypeKind.F32: {
            op = BinaryOp.AddF32;
            nativeType = NativeType.F32;
            nativeOne = this.module.createF32(1);
            break;
          }
          case TypeKind.F64: {
            op = BinaryOp.AddF64;
            nativeType = NativeType.F64;
            nativeOne = this.module.createF64(1);
            break;
          }
          case TypeKind.VOID: {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            throw new Error("concrete type expected");
          }
        }
        break;
      }
      case Token.MINUS_MINUS: {
        if (this.currentType.isReference) {
          this.error(
            DiagnosticCode.Operation_not_supported,
            expression.range
          );
          return this.module.createUnreachable();
        }
        switch (this.currentType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.BOOL: possiblyOverflows = true;
          default: {
            op = BinaryOp.SubI32;
            nativeType = NativeType.I32;
            nativeOne = this.module.createI32(1);
            break;
          }
          case TypeKind.USIZE: // TODO: check operator overload
          case TypeKind.ISIZE: {
            op = this.options.isWasm64
              ? BinaryOp.SubI64
              : BinaryOp.SubI32;
            nativeType = this.options.isWasm64
              ? NativeType.I64
              : NativeType.I32;
            nativeOne = this.currentType.toNativeOne(this.module);
            break;
          }
          case TypeKind.I64:
          case TypeKind.U64: {
            op = BinaryOp.SubI64;
            nativeType = NativeType.I64;
            nativeOne = this.module.createI64(1);
            break;
          }
          case TypeKind.F32: {
            op = BinaryOp.SubF32;
            nativeType = NativeType.F32;
            nativeOne = this.module.createF32(1);
            break;
          }
          case TypeKind.F64: {
            op = BinaryOp.SubF64;
            nativeType = NativeType.F64;
            nativeOne = this.module.createF64(1);
            break;
          }
          case TypeKind.VOID: {
            this.error(
              DiagnosticCode.Operation_not_supported,
              expression.range
            );
            throw new Error("concrete type expected");
          }
        }
        break;
      }
      default: {
        this.error(
          DiagnosticCode.Operation_not_supported,
          expression.range
        );
        throw new Error("unary postfix operator expected");
      }
    }

    var setValue: ExpressionRef;
    var tempLocal: Local | null = null;

    // simplify if dropped anyway
    if (contextualType == Type.void) {
      setValue = this.module.createBinary(op,
        getValue,
        nativeOne
      );

    // otherwise use a temp local for the intermediate value
    } else {
      tempLocal = this.currentFunction.getTempLocal(this.currentType);
      setValue = this.module.createBinary(op,
        this.module.createGetLocal(tempLocal.index, nativeType),
        nativeOne
      );
    }

    if (possiblyOverflows) {
      assert(this.currentType.is(TypeFlags.SMALL | TypeFlags.INTEGER));
      setValue = makeSmallIntegerWrap(setValue, this.currentType, this.module);
    }

    setValue = this.compileAssignmentWithValue(expression.operand, setValue, false);
    // ^ sets currentType = void
    if (contextualType == Type.void) {
      assert(!tempLocal);
      return setValue;
    }

    this.currentType = assert(tempLocal).type;
    this.currentFunction.freeTempLocal(<Local>tempLocal);
    return this.module.createBlock(null, [
      this.module.createSetLocal((<Local>tempLocal).index, getValue),
      setValue,
      this.module.createGetLocal((<Local>tempLocal).index, nativeType)
    ], nativeType);
  }

  compileUnaryPrefixExpression(
    expression: UnaryPrefixExpression,
    contextualType: Type,
    wrapSmallIntegers: bool = true
  ): ExpressionRef {
    var possiblyOverflows = false;
    var compound = false;
    var expr: ExpressionRef;

    switch (expression.operator) {
      case Token.PLUS: {
        if (this.currentType.isReference) {
          this.error(
            DiagnosticCode.Operation_not_supported,
            expression.range
          );
          return this.module.createUnreachable();
        }
        expr = this.compileExpression(
          expression.operand,
          contextualType == Type.void
            ? Type.i32
            : contextualType,
          ConversionKind.NONE,
          false // wrapped below
        );
        possiblyOverflows = this.currentType.is(TypeFlags.SMALL | TypeFlags.INTEGER); // if operand already did
        break;
      }
      case Token.MINUS: {
        if (this.currentType.isReference) {
          this.error(
            DiagnosticCode.Operation_not_supported,
            expression.range
          );
          return this.module.createUnreachable();
        }
        if (expression.operand.kind == NodeKind.LITERAL && (
          (<LiteralExpression>expression.operand).literalKind == LiteralKind.INTEGER ||
          (<LiteralExpression>expression.operand).literalKind == LiteralKind.FLOAT
        )) {
          // implicitly negate integer and float literals. also enables proper checking of literal ranges.
          expr = this.compileLiteralExpression(<LiteralExpression>expression.operand, contextualType, true);
          this.addDebugLocation(expr, expression.range); // compileExpression normally does this
        } else {
          expr = this.compileExpression(
            expression.operand,
            contextualType == Type.void
              ? Type.i32
              : contextualType,
            ConversionKind.NONE,
            false // wrapped below
          );
          switch (this.currentType.kind) {
            case TypeKind.I8:
            case TypeKind.I16:
            case TypeKind.U8:
            case TypeKind.U16:
            case TypeKind.BOOL: possiblyOverflows = true; // or if operand already did
            default: {
              expr = this.module.createBinary(BinaryOp.SubI32, this.module.createI32(0), expr);
              break;
            }
            case TypeKind.USIZE: {
              if (this.currentType.isReference) {
                this.error(
                  DiagnosticCode.Operation_not_supported,
                  expression.range
                );
                return this.module.createUnreachable();
              }
              // fall-through
            }
            case TypeKind.ISIZE: {
              expr = this.module.createBinary(
                this.options.isWasm64
                  ? BinaryOp.SubI64
                  : BinaryOp.SubI32,
                this.currentType.toNativeZero(this.module),
                expr
              );
              break;
            }
            case TypeKind.I64:
            case TypeKind.U64: {
              expr = this.module.createBinary(BinaryOp.SubI64, this.module.createI64(0), expr);
              break;
            }
            case TypeKind.F32: {
              expr = this.module.createUnary(UnaryOp.NegF32, expr);
              break;
            }
            case TypeKind.F64: {
              expr = this.module.createUnary(UnaryOp.NegF64, expr);
              break;
            }
          }
        }
        break;
      }
      case Token.PLUS_PLUS: {
        if (this.currentType.isReference) {
          this.error(
            DiagnosticCode.Operation_not_supported,
            expression.range
          );
          return this.module.createUnreachable();
        }
        compound = true;
        expr = this.compileExpression(
          expression.operand,
          contextualType == Type.void
            ? Type.i32
            : contextualType,
          ConversionKind.NONE,
          false // wrapped below
        );
        switch (this.currentType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.BOOL: possiblyOverflows = true; // or if operand already did
          default: {
            expr = this.module.createBinary(BinaryOp.AddI32, expr, this.module.createI32(1));
            break;
          }
          case TypeKind.USIZE: {
            if (this.currentType.isReference) {
              this.error(
                DiagnosticCode.Operation_not_supported,
                expression.range
              );
              return this.module.createUnreachable();
            }
            // fall-through
          }
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.AddI64
                : BinaryOp.AddI32,
              expr,
              this.currentType.toNativeOne(this.module)
            );
            break;
          }
          case TypeKind.I64:
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.AddI64, expr, this.module.createI64(1));
            break;
          }
          case TypeKind.F32: {
            expr = this.module.createBinary(BinaryOp.AddF32, expr, this.module.createF32(1));
            break;
          }
          case TypeKind.F64: {
            expr = this.module.createBinary(BinaryOp.AddF64, expr, this.module.createF64(1));
            break;
          }
        }
        break;
      }
      case Token.MINUS_MINUS: {
        if (this.currentType.isReference) {
          this.error(
            DiagnosticCode.Operation_not_supported,
            expression.range
          );
          return this.module.createUnreachable();
        }
        compound = true;
        expr = this.compileExpression(
          expression.operand,
          contextualType == Type.void
            ? Type.i32
            : contextualType,
          ConversionKind.NONE,
          false // wrapped below
        );
        switch (this.currentType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.BOOL: possiblyOverflows = true; // or if operand already did
          default: {
            expr = this.module.createBinary(BinaryOp.SubI32, expr, this.module.createI32(1));
            break;
          }
          case TypeKind.USIZE: {
            if (this.currentType.isReference) {
              this.error(
                DiagnosticCode.Operation_not_supported,
                expression.range
              );
              return this.module.createUnreachable();
            }
            // fall-through
          }
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.SubI64
                : BinaryOp.SubI32,
              expr,
              this.currentType.toNativeOne(this.module)
            );
            break;
          }
          case TypeKind.I64:
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.SubI64, expr, this.module.createI64(1));
            break;
          }
          case TypeKind.F32: {
            expr = this.module.createBinary(BinaryOp.SubF32, expr, this.module.createF32(1));
            break;
          }
          case TypeKind.F64: {
            expr = this.module.createBinary(BinaryOp.SubF64, expr, this.module.createF64(1));
            break;
          }
        }
        break;
      }
      case Token.EXCLAMATION: {
        expr = this.compileExpression(
          expression.operand,
          contextualType == Type.void
            ? Type.i32
            : contextualType,
          ConversionKind.NONE,
          true // must wrap small integers
        );
        expr = makeIsFalseish(expr, this.currentType, this.module);
        this.currentType = Type.bool;
        break;
      }
      case Token.TILDE: {
        if (this.currentType.isReference) {
          this.error(
            DiagnosticCode.Operation_not_supported,
            expression.range
          );
          return this.module.createUnreachable();
        }
        expr = this.compileExpression(
          expression.operand,
          contextualType == Type.void
            ? Type.i32
            : contextualType.is(TypeFlags.FLOAT)
              ? Type.i64
              : contextualType,
          contextualType == Type.void
            ? ConversionKind.NONE
            : ConversionKind.IMPLICIT,
          false // retains low bits of small integers
        );
        switch (this.currentType.kind) {
          case TypeKind.I8:
          case TypeKind.I16:
          case TypeKind.U8:
          case TypeKind.U16:
          case TypeKind.BOOL: possiblyOverflows = true; // or if operand already did
          default: {
            expr = this.module.createBinary(BinaryOp.XorI32, expr, this.module.createI32(-1));
            break;
          }
          case TypeKind.USIZE: {
            if (this.currentType.isReference) {
              this.error(
                DiagnosticCode.Operation_not_supported,
                expression.range
              );
              return this.module.createUnreachable();
            }
            // fall-through
          }
          case TypeKind.ISIZE: {
            expr = this.module.createBinary(
              this.options.isWasm64
                ? BinaryOp.XorI64
                : BinaryOp.XorI32,
              expr,
              this.currentType.toNativeNegOne(this.module)
            );
            break;
          }
          case TypeKind.I64:
          case TypeKind.U64: {
            expr = this.module.createBinary(BinaryOp.XorI64, expr, this.module.createI64(-1, -1));
            break;
          }
        }
        break;
      }
      case Token.TYPEOF: {
        // it might make sense to implement typeof in a way that a generic function can detect
        // whether its type argument is a class type or string. that could then be used, for
        // example, to generate hash codes for sets and maps, depending on the kind of type
        // parameter we have. ideally the comparison would not involve actual string comparison and
        // limit available operations to hard-coded string literals.
        this.error(
          DiagnosticCode.Operation_not_supported,
          expression.range
        );
        throw new Error("not implemented");
      }
      default: {
        this.error(
          DiagnosticCode.Operation_not_supported,
          expression.range
        );
        throw new Error("unary operator expected");
      }
    }
    if (possiblyOverflows && wrapSmallIntegers) {
      assert(this.currentType.is(TypeFlags.SMALL | TypeFlags.INTEGER));
      expr = makeSmallIntegerWrap(expr, this.currentType, this.module);
    }
    return compound
      ? this.compileAssignmentWithValue(expression.operand, expr, contextualType != Type.void)
      : expr;
  }

  addDebugLocation(expr: ExpressionRef, range: Range): void {
    if (!this.options.sourceMap) return;
    var source = range.source;
    if (source.debugInfoIndex < 0) {
      source.debugInfoIndex = this.module.addDebugInfoFile(source.normalizedPath);
    }
    range.debugInfoRef = expr;
    if (!this.currentFunction.debugLocations) this.currentFunction.debugLocations = [];
    this.currentFunction.debugLocations.push(range);
  }
}

// helpers

/** Wraps a 32-bit integer expression so it evaluates to a valid value of the specified type. */
export function makeSmallIntegerWrap(expr: ExpressionRef, type: Type, module: Module): ExpressionRef {
  switch (type.kind) {
    case TypeKind.I8: {
      expr = module.createBinary(BinaryOp.ShrI32,
        module.createBinary(BinaryOp.ShlI32,
          expr,
          module.createI32(24)
        ),
        module.createI32(24)
      );
      break;
    }
    case TypeKind.I16: {
      expr = module.createBinary(BinaryOp.ShrI32,
        module.createBinary(BinaryOp.ShlI32,
          expr,
          module.createI32(16)
        ),
        module.createI32(16)
      );
      break;
    }
    case TypeKind.U8: {
      expr = module.createBinary(BinaryOp.AndI32,
        expr,
        module.createI32(0xff)
      );
      break;
    }
    case TypeKind.U16: {
      expr = module.createBinary(BinaryOp.AndI32,
        expr,
        module.createI32(0xffff)
      );
      break;
    }
    case TypeKind.BOOL: {
      expr = module.createBinary(BinaryOp.AndI32,
        expr,
        module.createI32(0x1)
      );
      break;
    }
    default: {
      throw new Error("small integer type expected");
    }
  }
  return expr;
}

/** Creates a comparison whether an expression is not 'true' in a broader sense. */
export function makeIsFalseish(expr: ExpressionRef, type: Type, module: Module): ExpressionRef {
  switch (type.kind) {
    default: { // any integer up to 32 bits
      expr = module.createUnary(UnaryOp.EqzI32, expr);
      break;
    }
    case TypeKind.I64:
    case TypeKind.U64: {
      expr = module.createUnary(UnaryOp.EqzI64, expr);
      break;
    }
    case TypeKind.USIZE:
      // TODO: strings
    case TypeKind.ISIZE: {
      expr = module.createUnary(type.size == 64 ? UnaryOp.EqzI64 : UnaryOp.EqzI32, expr);
      break;
    }
    case TypeKind.F32: {
      expr = module.createBinary(BinaryOp.EqF32, expr, module.createF32(0));
      break;
    }
    case TypeKind.F64: {
      expr = module.createBinary(BinaryOp.EqF64, expr, module.createF64(0));
      break;
    }
    case TypeKind.VOID: {
      throw new Error("concrete type expected");
    }
  }
  return expr;
}

/** Creates a comparison whether an expression is 'true' in a broader sense. */
export function makeIsTrueish(expr: ExpressionRef, type: Type, module: Module): ExpressionRef {
  switch (type.kind) {
    case TypeKind.I64:
    case TypeKind.U64: {
      expr = module.createBinary(BinaryOp.NeI64, expr, module.createI64(0));
      break;
    }
    case TypeKind.USIZE: // TODO: strings
    case TypeKind.ISIZE: {
      if (type.size == 64) {
        expr = module.createBinary(BinaryOp.NeI64, expr, module.createI64(0));
      }
      break;
    }
    case TypeKind.F32: {
      expr = module.createBinary(BinaryOp.NeF32, expr, module.createF32(0));
      break;
    }
    case TypeKind.F64: {
      expr = module.createBinary(BinaryOp.NeF64, expr, module.createF64(0));
      break;
    }
    case TypeKind.VOID: {
      throw new Error("concrete type expected");
    }
  }
  return expr;
}
