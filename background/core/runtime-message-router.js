(function (global) {
    function isPromiseLike(value) {
        return !!value && typeof value.then === 'function';
    }

    function getErrorMessage(error) {
        if (!error) return '未知错误';
        if (typeof error === 'string') return error;
        return error.message || String(error);
    }

    function reportRouteError(action, error, onError) {
        if (typeof onError !== 'function') return;
        try {
            onError(action, error);
        } catch {}
    }

    function create(config = {}) {
        const fireAndForget = config.fireAndForget || {};
        const asyncActions = config.asyncActions || {};
        const onError = config.onError;
        const onUnknownAction = config.onUnknownAction;

        return (msg = {}, sender, sendResponse) => {
            const action = String(msg?.action || '');
            if (!action) return false;

            const fireHandler = fireAndForget[action];
            if (typeof fireHandler === 'function') {
                try {
                    const result = fireHandler(msg, sender);
                    if (isPromiseLike(result)) {
                        result.catch((error) => reportRouteError(action, error, onError));
                    }
                } catch (error) {
                    reportRouteError(action, error, onError);
                }
                return false;
            }

            const asyncHandler = asyncActions[action];
            if (typeof asyncHandler === 'function') {
                Promise.resolve()
                    .then(() => asyncHandler(msg, sender))
                    .then((result) => {
                        sendResponse(result === undefined ? { success: true } : result);
                    })
                    .catch((error) => {
                        reportRouteError(action, error, onError);
                        sendResponse({
                            success: false,
                            message: getErrorMessage(error),
                            action
                        });
                    });
                return true;
            }

            if (typeof onUnknownAction === 'function') {
                return !!onUnknownAction(msg, sender, sendResponse);
            }

            return false;
        };
    }

    global.RuntimeMessageRouter = {
        create
    };
})(self);
