// 1. Define custom Error classes to mirror your ABAP exceptions
export class InvalidParametersError extends Error {
  constructor(message = 'Invalid parameters provided') {
    super(message);
    this.name = 'InvalidParametersError';
  }
}

export class OperationCancelledError extends Error {
  constructor(message = 'Operation was cancelled') {
    super(message);
    this.name = 'OperationCancelledError';
  }
}

export class NotImplementedError extends Error {
  constructor(message = 'Method is not implemented') {
    super(message);
    this.name = 'NotImplementedError';
  }
}


