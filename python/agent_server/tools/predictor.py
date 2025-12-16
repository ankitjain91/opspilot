import logging

logger = logging.getLogger(__name__)

def predict_scaling(resource_type: str, name: str, history: list[float], horizon_minutes: int = 30) -> str:
    """
    Predict future resource usage using linear regression on historical data.
    
    Args:
        resource_type: e.g. "deployment"
        name: resource name
        history: list of float values (e.g. CPU/Memory usage). Assumed to be evenly spaced.
        horizon_minutes: how far into the future (in 'steps', assuming 1 step = 1 minute roughly for now)
    
    Returns:
        Formatted string with prediction result.
    """
    if not history or len(history) < 2:
        return f"Insufficient history (need at least 2 points) to predict scaling for {resource_type}/{name}."

    try:
        import numpy as np
        # X axis = time steps (0, 1, 2...)
        x = np.arange(len(history))
        y = np.array(history)
        
        # Linear regression (degree 1)
        slope, intercept = np.polyfit(x, y, 1)
        
        # Predict future value
        # Current time is len(history) - 1
        # Future time is current + horizon_minutes (assuming 1 min intervals for simplicity)
        future_x = (len(history) - 1) + horizon_minutes
        predicted_value = slope * future_x + intercept
        
        trend = "increasing" if slope > 0 else "decreasing"
        
        return (
            f"PREDICTION for {resource_type}/{name} (+{horizon_minutes} mins):\n"
            f"  - Trend: {trend} (slope: {slope:.4f})\n"
            f"  - Current (~): {history[-1]:.2f}\n"
            f"  - Predicted: {predicted_value:.2f}\n"
            f"  - Recommendation: {recommendation(history[-1], predicted_value, slope)}"
        )
        
    except ImportError:
        # Fallback: simple line between first and last point (very rough)
        slope = (history[-1] - history[0]) / len(history)
        future_value = history[-1] + (slope * horizon_minutes)
        return (
            f"PREDICTION (Basic) for {resource_type}/{name} (+{horizon_minutes} mins):\n"
            f"  - Estimated: {future_value:.2f}\n"
            f"  - Note: numpy not available, using simple linear projection."
        )
    except Exception as e:
        return f"Prediction failed: {e}"

def recommendation(current: float, predicted: float, slope: float) -> str:
    if predicted > current * 1.2:
        return "CONSIDER SCALING UP (Usage projected to grow >20%)"
    elif predicted < current * 0.5 and slope < 0:
        return "CONSIDER SCALING DOWN (Usage projecting significant drop)"
    else:
        return "STABLE (No immediate scaling needed)"
