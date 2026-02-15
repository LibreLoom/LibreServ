import { useState, useCallback } from 'react';

/**
 * Custom hook for handling errors in async operations
 * 
 * @returns {Object} Error handling utilities
 * @returns {Error|null} error - Current error state
 * @returns {boolean} isError - Whether an error exists
 * @returns {Function} setError - Set error manually
 * @returns {Function} clearError - Clear current error
 * @returns {Function} handleError - Wrap async functions with error handling
 * @returns {Function} withErrorHandling - HOF for wrapping async functions
 * 
 * @example
 * const { error, isError, clearError, handleError } = useErrorHandler();
 * 
 * const fetchData = handleError(async () => {
 *   const response = await api.get('/data');
 *   return response.data;
 * });
 */
export function useErrorHandler() {
  const [error, setErrorState] = useState(null);

  const setError = useCallback((err) => {
    // Normalize error to ensure consistent structure
    if (err instanceof Error) {
      setErrorState(err);
    } else if (typeof err === 'string') {
      setErrorState(new Error(err));
    } else {
      setErrorState(new Error('An unknown error occurred'));
    }
  }, []);

  const clearError = useCallback(() => {
    setErrorState(null);
  }, []);

  const handleError = useCallback((asyncFn) => {
    return async (...args) => {
      try {
        clearError();
        return await asyncFn(...args);
      } catch (err) {
        setError(err);
        throw err; // Re-throw so caller can also handle it
      }
    };
  }, [clearError, setError]);

  const withErrorHandling = useCallback((asyncFn) => {
    return handleError(asyncFn);
  }, [handleError]);

  return {
    error,
    isError: error !== null,
    setError,
    clearError,
    handleError,
    withErrorHandling,
  };
}

/**
 * Higher-order component for adding error handling to components
 * 
 * @param {React.Component} WrappedComponent - Component to wrap
 * @returns {React.Component} Component with error handling
 * 
 * @example
 * const MyComponentWithError = withErrorHandling(MyComponent);
 */
export function withErrorHandling(WrappedComponent) {
  return function WithErrorHandlingComponent(props) {
    const errorHandler = useErrorHandler();
    
    return (
      <WrappedComponent 
        {...props} 
        errorHandler={errorHandler}
      />
    );
  };
}

/**
 * Hook for handling API errors with specific error types
 * 
 * @returns {Object} API error handling utilities
 */
export function useApiErrorHandler() {
  const { error, isError, setError, clearError } = useErrorHandler();

  const handleApiError = useCallback((err) => {
    // Check for specific HTTP status codes
    if (err.cause?.status) {
      switch (err.cause.status) {
        case 401:
          setError(new Error('Your session has expired. Please log in again.'));
          break;
        case 403:
          setError(new Error('You do not have permission to perform this action.'));
          break;
        case 404:
          setError(new Error('The requested resource was not found.'));
          break;
        case 429:
          setError(new Error('Too many requests. Please try again later.'));
          break;
        case 500:
        case 502:
        case 503:
          setError(new Error('Server error. Please try again later.'));
          break;
        default:
          setError(err);
      }
    } else if (err.message?.includes('NetworkError') || err.message?.includes('fetch')) {
      setError(new Error('Network error. Please check your connection.'));
    } else {
      setError(err);
    }
  }, [setError]);

  const handleApiCall = useCallback((asyncFn) => {
    return async (...args) => {
      try {
        clearError();
        return await asyncFn(...args);
      } catch (err) {
        handleApiError(err);
        throw err;
      }
    };
  }, [clearError, handleApiError]);

  return {
    error,
    isError,
    clearError,
    handleApiError,
    handleApiCall,
  };
}

export default useErrorHandler;
