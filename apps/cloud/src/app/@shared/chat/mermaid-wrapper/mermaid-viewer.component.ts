import { CommonModule } from '@angular/common'
import { AfterViewInit, Component, ElementRef, Input } from '@angular/core'
import { MatTooltipModule } from '@angular/material/tooltip'
import { TranslateModule } from '@ngx-translate/core'
import mermaid from 'mermaid'
import { CopyComponent } from '../../common'

let mermaidInitialized = false
let idCounter = 0

@Component({
  standalone: true,
  imports: [CommonModule, MatTooltipModule, TranslateModule, CopyComponent],
  selector: 'chat-mermaid-viewer',
  template: `<div class="group/mermaid relative my-4">
    <copy
      #copy
      class="absolute -top-2 right-2 opacity-30 group-hover/mermaid:opacity-100 z-10"
      [content]="code"
      [matTooltip]="
        copy.copied()
          ? ('PAC.Xpert.Copied' | translate: { Default: 'Copied' })
          : ('PAC.Xpert.Copy' | translate: { Default: 'Copy' })
      "
      matTooltipPosition="above"
    />
    <div class="mermaid-container overflow-auto"></div>
  </div>`
})
export class MermaidViewerComponent implements AfterViewInit {
  @Input() code!: string

  constructor(private el: ElementRef) {}

  async ngAfterViewInit() {
    if (!mermaidInitialized) {
      mermaid.initialize({ startOnLoad: false, theme: 'default' })
      mermaidInitialized = true
    }

    const container = this.el.nativeElement.querySelector('.mermaid-container')
    if (this.code && container) {
      try {
        const id = `mermaid-graph-${idCounter++}`
        const { svg } = await mermaid.render(id, this.code)
        container.innerHTML = svg
      } catch (err) {
        console.error('Invalid mermaid syntax', err)
        container.textContent = this.code
      }
    }
  }
}
