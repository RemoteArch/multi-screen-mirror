import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts

class MediaProjectionRequester(
    private val activity: Activity,
    private val onResult: (MediaProjection?) -> Unit
) {

    private val projectionManager =
        activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE)
                as MediaProjectionManager

    private val launcher: ActivityResultLauncher<Intent> =
        activity.registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            if (result.resultCode == Activity.RESULT_OK && result.data != null) {
                val mediaProjection =
                    projectionManager.getMediaProjection(
                        result.resultCode,
                        result.data!!
                    )
                onResult(mediaProjection)
            } else {
                onResult(null)
            }
        }

    fun request() {
        launcher.launch(projectionManager.createScreenCaptureIntent())
    }
}